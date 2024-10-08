import { wrapWithLoggerContext } from "@saleor/apps-logger/node";
import { withOtel } from "@saleor/apps-otel";
import { ObservabilityAttributes } from "@saleor/apps-otel/src/lib/observability-attributes";
import * as Sentry from "@sentry/nextjs";
import { captureException } from "@sentry/nextjs";

import { AppConfigExtractor } from "../../../lib/app-config-extractor";
import { AppConfigurationLogger } from "../../../lib/app-configuration-logger";
import { metadataCache, wrapWithMetadataCache } from "../../../lib/app-metadata-cache";
import { SubscriptionPayloadErrorChecker } from "../../../lib/error-utils";
import { createLogger } from "../../../logger";
import { loggerContext } from "../../../logger-context";
import { SaleorCancelledOrderEvent } from "../../../modules/saleor";
import {
  OrderCancelNoAvataxIdError,
  OrderCancelPayloadOrderError,
} from "../../../modules/saleor/order-cancelled/errors";
import { orderCancelledAsyncWebhook } from "../../../modules/webhooks/definitions/order-cancelled";

export const config = {
  api: {
    bodyParser: false,
  },
};

const logger = createLogger("orderCancelledAsyncWebhook");
const withMetadataCache = wrapWithMetadataCache(metadataCache);
const subscriptionErrorChecker = new SubscriptionPayloadErrorChecker(logger, captureException);

export default wrapWithLoggerContext(
  withOtel(
    withMetadataCache(
      orderCancelledAsyncWebhook.createHandler(async (req, res, ctx) => {
        const { payload } = ctx;

        subscriptionErrorChecker.checkPayload(payload);

        if (payload.version) {
          Sentry.setTag(ObservabilityAttributes.SALEOR_VERSION, payload.version);
          loggerContext.set(ObservabilityAttributes.SALEOR_VERSION, payload.version);
        }

        logger.info("Handler called with payload");

        const cancelledOrderFromPayload = SaleorCancelledOrderEvent.create(payload);

        if (cancelledOrderFromPayload.isErr()) {
          const error = cancelledOrderFromPayload.error;

          switch (true) {
            case error instanceof OrderCancelPayloadOrderError: {
              logger.error("Insufficient order data", { error });
              Sentry.captureException("Insufficient order data");

              return res
                .status(400)
                .json({ message: `Invalid order payload for order: ${payload.order?.id}` });
            }
            case error instanceof OrderCancelNoAvataxIdError: {
              logger.warn("No AvaTax id found in order. Likely not an AvaTax order.", {
                error,
              });
              return res
                .status(200)
                .json({ message: "Invalid order payload. Likely not an AvaTax order." });
            }
            case error instanceof SaleorCancelledOrderEvent.ParsingError: {
              logger.error("Error parsing order payload", { error });
              Sentry.captureException(error);

              return res
                .status(400)
                .json({ message: `Invalid order payload for order: ${payload.order?.id}` });
            }
            default: {
              logger.error("Unhandled error", { error });
              Sentry.captureException(error);

              return res
                .status(500)
                .json({ message: `Unhandled error for order: ${payload.order?.id}` });
            }
          }
        }

        const cancelledOrderInstance = cancelledOrderFromPayload.value;

        const appMetadata = cancelledOrderInstance.getPrivateMetadata() || [];

        const channelSlug = cancelledOrderInstance.getChannelSlug();

        const configExtractor = new AppConfigExtractor();

        const config = configExtractor
          .extractAppConfigFromPrivateMetadata(appMetadata)
          .map((config) => {
            try {
              new AppConfigurationLogger(logger).logConfiguration(config, channelSlug);
            } catch (e) {
              captureException(
                new AppConfigExtractor.LogConfigurationMetricError(
                  "Failed to log configuration metric",
                  {
                    cause: e,
                  },
                ),
              );
            }

            return config;
          });

        if (config.isErr()) {
          logger.warn("Failed to extract app config from metadata", { error: config.error });

          return res
            .status(400)
            .json({ message: `App configuration is broken for order: ${payload.order?.id}` });
        }

        const AvataxWebhookServiceFactory = await import(
          "../../../modules/taxes/avatax-webhook-service-factory"
        ).then((m) => m.AvataxWebhookServiceFactory);

        const avataxWebhookServiceResult = AvataxWebhookServiceFactory.createFromConfig(
          config.value,
          channelSlug,
        );

        logger.info("Cancelling order...");

        if (avataxWebhookServiceResult.isOk()) {
          const { taxProvider } = avataxWebhookServiceResult.value;
          const providerConfig = config.value.getConfigForChannelSlug(channelSlug);

          if (providerConfig.isErr()) {
            return res
              .status(400)
              .json({ message: `App is not configured properly for order: ${payload.order?.id}` });
          }

          await taxProvider.cancelOrder(
            {
              avataxId: cancelledOrderInstance.getAvataxId(),
            },
            providerConfig.value.avataxConfig.config,
          );

          logger.info("Order cancelled");

          return res.status(200).end();
        }

        if (avataxWebhookServiceResult.isErr()) {
          logger.error("Tax provider couldn't cancel the order:", avataxWebhookServiceResult.error);

          switch (avataxWebhookServiceResult.error["constructor"]) {
            case AvataxWebhookServiceFactory.BrokenConfigurationError: {
              return res.status(400).json({ message: "App is not configured properly." });
            }
            default: {
              Sentry.captureException(avataxWebhookServiceResult.error);
              logger.fatal("Unhandled error", { error: avataxWebhookServiceResult.error });

              return res.status(500).json({ message: "Unhandled error" });
            }
          }
        }
      }),
    ),
    "/api/webhooks/order-cancelled",
  ),
  loggerContext,
);
