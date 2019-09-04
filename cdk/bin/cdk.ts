#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import { BaseStack } from '../lib/base-stack';
import { DBStack } from '../lib/db-stack';
import { EcsStack } from '../lib/ecs-stack';

const app = new cdk.App();
const baseStack = new BaseStack(app, 'springgroot-base-infra');

const dbStack = new DBStack(app, "springgroot-db", {
  vpc: baseStack.vpc
});

new EcsStack(app, 'springgroot-fargate-svc', {
  cluster: baseStack.cluster,
  dbCluster: dbStack.dbCluster
})
