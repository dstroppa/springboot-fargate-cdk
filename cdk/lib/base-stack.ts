import cdk = require('@aws-cdk/core');
import ecs = require('@aws-cdk/aws-ecs');
import ec2 = require('@aws-cdk/aws-ec2');

export class BaseStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly cluster: ecs.Cluster;
  
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id);

    // Network to run everything in
    this.vpc = new ec2.Vpc(this, 'vpc-springgroot', {
      maxAzs: 3,
      natGateways: 1
    });
    
    // Cluster all the containers will run in
    this.cluster = new ecs.Cluster(this, 'springgroot-cluster', { 
      vpc: this.vpc
    });
  }
}
