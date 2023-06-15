/* eslint-disable turbo/no-undeclared-env-vars */

import { SaleorCloudAPL } from "@saleor/app-sdk/APL";
import { createClient } from "../../src/lib/graphql";
import { createSettingsManager } from "../../src/modules/app/metadata-manager";

export const getMetadataManagerForEnv = (apiUrl: string, appToken: string, appId: string) => {
  const client = createClient(apiUrl, async () => ({
    token: appToken,
  }));

  return createSettingsManager(client, appId);
};

export const verifyRequiredEnvs = () => {
  const requiredEnvs = ["SALEOR_CLOUD_TOKEN", "SALEOR_CLOUD_RESOURCE_URL", "SECRET_KEY"];

  if (!requiredEnvs.every((env) => process.env[env])) {
    throw new Error(`Missing envs: ${requiredEnvs.join(" | ")}`);
  }
};

export const fetchCloudAplEnvs = () => {
  const saleorAPL = new SaleorCloudAPL({
    token: process.env.SALEOR_CLOUD_TOKEN!,
    resourceUrl: process.env.SALEOR_CLOUD_RESOURCE_URL!,
  });

  return saleorAPL.getAll();
};
