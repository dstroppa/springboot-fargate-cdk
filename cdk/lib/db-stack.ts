import cdk = require('@aws-cdk/core');
import ec2 = require('@aws-cdk/aws-ec2');
import rds = require('@aws-cdk/aws-rds');
import ssm = require('@aws-cdk/aws-ssm');

interface DBStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
}

export class DBStack extends cdk.Stack {
  public readonly dbCluster: rds.CfnDBCluster;
  
  constructor(scope: cdk.Construct, id: string, props: DBStackProps) {
    super(scope, id);

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
