const cdk = require('@aws-cdk/core');
const ecs = require('@aws-cdk/aws-ecs');
const ec2 = require('@aws-cdk/aws-ec2');
const rds = require('@aws-cdk/aws-rds');
const ecs_patterns = require('@aws-cdk/aws-ecs-patterns');
const cloudwatch = require('@aws-cdk/aws-cloudwatch');
const iam = require('@aws-cdk/aws-iam');
const ssm = require('@aws-cdk/aws-ssm');
const kms = require('@aws-cdk/aws-kms');

class BaseInfraResources extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Network to run everything in
    this.vpc = new ec2.Vpc(this, 'vpc-springgroot', {
      maxAZs: 3,
      natGateways: 1
    });
    // Cluster all the containers will run in
    this.cluster = new ecs.Cluster(this, 'springgroot-cluster', { vpc: this.vpc });
  }
}

// RDS 
class MySQLDatabase extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    const dbsecuritygroup = new ec2.SecurityGroup(this, 'dbsg', {
      vpc: props.vpc,
      description: "database security group"
    })

    dbsecuritygroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306), "Allow inbound to db")

    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'Subnet', {
      subnetIds: props.vpc.privateSubnets.map(privateSubnet => privateSubnet.subnetId),
      dbSubnetGroupDescription: 'Database subnet group',
    });

    let ssmdbpassword = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ssmDBpassword', {
      parameterName: '/mysqlpassword',
      version: 1
    })

    //   this.rds = new rds.CfnDBInstance(this, "mysql-single-instance", {
    //     allocatedStorage: '80',
    //     dbInstanceClass: 'db.m5.large',
    //     engine: 'mysql',
    //     dbName: 'notes_app',
    //     engineVersion: '5.7.25',
    //     masterUsername: 'dbaadmin',
    //     masterUserPassword: ssmdbpassword.stringValue,
    //     dbSubnetGroupName: subnetGroup.ref,
    //     vpcSecurityGroups: [dbsecuritygroup.securityGroupId]
    //   })
    // }
    this.dbCluster = new rds.CfnDBCluster(this, "myDBCluster", {
      engine: 'aurora',
      engineMode: 'serverless',
      databaseName: 'notes_app',
      masterUsername: 'dbaadmin',
      masterUserPassword: ssmdbpassword.stringValue,
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [dbsecuritygroup.securityGroupId],
      scalingConfiguration: {
        autoPause: true,
        minCapacity: 2,
        maxCapacity: 8,
        secondsUntilAutoPause: 600
      }
    });
  }
}

class FargateService extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    this.springgroot = new ecs_patterns.LoadBalancedFargateService(this, 'springgrootsvc', {
      cluster: props.cluster,
      image: ecs.ContainerImage.fromAsset('./springgroot-jpa'),
      containerPort: 8080,
      desiredCount: 2,
      cpu: '512',
      memoryLimitMiB: '1024',
      environment: {
        // AWS_XRAY_CONTEXT_MISSING: 'LOG_ERROR'
        'springdatasourceurl': `jdbc:mysql://` + props.springgrootDB.dbCluster.attrEndpointAddress + `:3306/notes_app?autoReconnect=true&useUnicode=true&characterEncoding=UTF-8&allowMultiQueries=true`,
        'springdatasourceusername': 'dbaadmin'
      },
      createLogs: true
    })

    //customize healthcheck
    this.springgroot.targetGroup.configureHealthCheck({
      "port": 'traffic-port',
      "path": '/',
      "interval": cdk.Duration.seconds(5),
      "timeout": cdk.Duration.seconds(4),
      "healthyThresholdCount": 2,
      "unhealthyThresholdCount": 2,
      "healthyHttpCodes": "200,301,302"
    })

    //https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html
    let ssmMasterKey = kms.Key.fromKeyArn(this, 'ssmmasterkey', 'arn:aws:kms:' + this.region + ':' + this.account + ':alias/aws/ssm')
    ssmMasterKey.grantDecrypt(this.springgroot.service.taskDefinition.executionRole)

    let ssmdbpassword = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ssmDBpassword', {
      parameterName: '/mysqlpassword',
      version: 1
    })
    // ssmdbpassword.grantRead(this.springgroot.service.taskDefinition.executionRole)  -> can't use this as it gives "ssm:GetParameter"
    this.springgroot.service.taskDefinition.executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: [ssmdbpassword.parameterArn]
      })
    )

    // Work Around Missing AWS CDK Features - https://docs.aws.amazon.com/cdk/latest/guide/cfn_layer.html 
    // https://github.com/awslabs/aws-cdk/pull/2994 
    let fgs = this.springgroot.service.taskDefinition.node.findChild('Resource')
    fgs.addPropertyOverride('ContainerDefinitions.0.Secrets', [{
      Name: "mysqlpassword",
      ValueFrom: ssmdbpassword.parameterArn
    }])

    // ## Autoscaling Tasks  - Target Tracking 
    let springgrootServiceAutoScaleTask = this.springgroot.service.autoScaleTaskCount({
      maxCapacity: 20,
      minCapacity: 2
    })

    // custom metric target tracking
    // while true; do aws cloudwatch put-metric-data --metric-name CDKTestingCustomMetric --namespace "CDK/Testing" --value $(( ( RANDOM % 10 ) + 180 )); sleep 60; done
    springgrootServiceAutoScaleTask.scaleToTrackCustomMetric('CustomMetricScaling', {
      metric: new cloudwatch.Metric({
        namespace: "CDK/Testing",
        metricName: 'CDKTestingCustomMetric',
        statistic: 'avg',
        periodSec: 60
      }),
      targetValue: 150,
      scaleInCooldownSec: 60, //default 300
      scaleOutCooldownSec: 60,
      policyName: "KeepIt150"
    })

    // ==== Cloudwatch Dashboard
    this.dashboard = new cloudwatch.Dashboard(this, "springgroot2-dashboard");
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Springboot on Fargate Dashboard',
        width: 24
      })
    )

    this.dashboard.addWidgets(new cloudwatch.GraphWidget({
      title: "springgroot Task Count",
      width: 8,
      leftYAxis: {
        min: 0
      },
      left: [new cloudwatch.Metric({
        namespace: "AWS/ECS",
        metricName: 'CPUUtilization',
        label: "Running",
        dimensions: {
          ServiceName: this.springgroot.service.serviceName,
          ClusterName: props.cluster.clusterName
        },
        statistic: 'n',
        period: cdk.Duration.minutes(1)
      })]
    }),
      new cloudwatch.GraphWidget({
        title: "ReqCountPerTarget",
        left: [new cloudwatch.Metric({
          namespace: "AWS/ApplicationELB",
          metricName: "RequestCountPerTarget",
          dimensions: {
            TargetGroup: this.springgroot.targetGroup.targetGroupFullName,
            LoadBalancer: this.springgroot.loadBalancer.loadBalancerFullName
          },
          color: '#98df8a',
          statistic: 'sum',
          period: cdk.Duration.minutes(1)
        })
        ],
        stacked: true
      }),
      new cloudwatch.GraphWidget({
        title: "Custom Metric",
        left: [new cloudwatch.Metric({
          namespace: "CDK/Testing",
          metricName: "CDKTestingCustomMetric",
          color: '#d62728',
          statistic: 'avg',
          period: cdk.Duration.minutes(1),
          // HorizontalAnnotation: {
          //   value: 150,
          //   label: "breach 150"
          // }
        })
        ]
      })
    )

    this.dashboard.addWidgets(new cloudwatch.GraphWidget({
      title: "springgroot Task CPU",
      width: 8,
      leftYAxis: {
        min: 0
      },
      left: [
        new cloudwatch.Metric({
          namespace: "AWS/ECS",
          metricName: 'CPUUtilization',
          label: "CPUUtilization",
          dimensions: {
            ServiceName: this.springgroot.service.serviceName,
            ClusterName: props.cluster.clusterName
          },
          statistic: 'avg',
          period: cdk.Duration.minutes(1)
        })],
      right: [new cloudwatch.Metric({
        namespace: "AWS/ECS",
        metricName: 'MemoryUtilization',
        label: "MemoryUtilization",
        dimensions: {
          ServiceName: this.springgroot.service.serviceName,
          ClusterName: props.cluster.clusterName
        },
        statistic: 'avg',
        period: cdk.Duration.minutes(1)
      })]
    }),
      new cloudwatch.GraphWidget({
        title: "TargetResponseTime (P95)",
        left: [new cloudwatch.Metric({
          namespace: "AWS/ApplicationELB",
          metricName: "TargetResponseTime",
          dimensions: {
            TargetGroup: this.springgroot.targetGroup.targetGroupFullName,
            LoadBalancer: this.springgroot.loadBalancer.loadBalancerFullName
          },
          color: '#2ca02c',
          statistic: 'p95',
          period: cdk.Duration.minutes(1)
        })
        ],
        stacked: true
      }),
    )
    // -- end CW Dashboard
  }
}

class App extends cdk.App {
  constructor(argv) {
    super(argv);
    this.baseResources = new BaseInfraResources(this, 'springgroot-base-infra');

    this.springgrootDB = new MySQLDatabase(this, "springgroot-db", {
      vpc: this.baseResources.vpc,
      ecscluster: this.baseResources.cluster
    });

    this.springbootApp = new FargateService(this, 'springgroot-fargate-svc', {
      cluster: this.baseResources.cluster,
      springgrootDB: this.springgrootDB
    })
  }
}
new App().synth();