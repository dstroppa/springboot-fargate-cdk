import cdk = require('@aws-cdk/core');
import ecs = require('@aws-cdk/aws-ecs');
import rds = require('@aws-cdk/aws-rds');
import ecs_patterns = require('@aws-cdk/aws-ecs-patterns');
import cloudwatch = require('@aws-cdk/aws-cloudwatch');
import iam = require('@aws-cdk/aws-iam');
import ssm = require('@aws-cdk/aws-ssm');
import kms = require('@aws-cdk/aws-kms');

interface EcsStackProps extends cdk.StackProps {
  cluster: ecs.Cluster;
  dbCluster: rds.CfnDBCluster;
}

export class EcsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const ssmdbpassword = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'ssmDBpassword', {
      parameterName: '/mysqlpassword',
      version: 1
    })

    const springgroot = new ecs_patterns.LoadBalancedFargateService(this, 'springgrootsvc', {
      cluster: props.cluster,
      image: ecs.ContainerImage.fromAsset('../springgroot-jpa'),
      containerPort: 8080,
      desiredCount: 2,
      cpu: 512,
      memoryLimitMiB: 1024,
      environment: {
        'springdatasourceurl': `jdbc:mysql://` + props.dbCluster.attrEndpointAddress + `:3306/notes_app?autoReconnect=true&useUnicode=true&characterEncoding=UTF-8&allowMultiQueries=true`,
        'springdatasourceusername': 'dbaadmin'
      },
      secrets: {
        'mysqlpassword': ecs.Secret.fromSsmParameter(ssmdbpassword)
      },
      enableLogging: true
    })

    //customize healthcheck
    springgroot.targetGroup.configureHealthCheck({
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
    ssmMasterKey.grantDecrypt(springgroot.service.taskDefinition.obtainExecutionRole())
    
    //springgroot.service.taskDefinition.addToExecutionRolePolicy(
    //  new iam.PolicyStatement({
    //    actions: ["ssm:GetParameters"],
    //    resources: [ssmdbpassword.parameterArn]
    //  })
    //)

    // ## Autoscaling Tasks  - Target Tracking 
    let springgrootServiceAutoScaleTask = springgroot.service.autoScaleTaskCount({
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
        period: cdk.Duration.seconds(60)
      }),
      targetValue: 150,
      scaleInCooldown: cdk.Duration.seconds(60), //default 300
      scaleOutCooldown: cdk.Duration.seconds(60),
      policyName: "KeepIt150"
    })

    // ==== Cloudwatch Dashboard
    const dashboard = new cloudwatch.Dashboard(this, "springgroot2-dashboard");
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Springboot on Fargate Dashboard',
        width: 24
      })
    )

    dashboard.addWidgets(new cloudwatch.GraphWidget({
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
          ServiceName: springgroot.service.serviceName,
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
            TargetGroup: springgroot.targetGroup.targetGroupFullName,
            LoadBalancer: springgroot.loadBalancer.loadBalancerFullName
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

    dashboard.addWidgets(new cloudwatch.GraphWidget({
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
            ServiceName: springgroot.service.serviceName,
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
          ServiceName: springgroot.service.serviceName,
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
            TargetGroup: springgroot.targetGroup.targetGroupFullName,
            LoadBalancer: springgroot.loadBalancer.loadBalancerFullName
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