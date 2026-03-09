import * as Joi from 'joi';

/**
 * Validation schema for environment variables.
 * Ensures the NestJS application refuses to start if required
 * configuration for the LND node is missing or malformed.
 */
export const envValidationSchema = Joi.object({
    LND_SOCKET: Joi.string().required(),
    LND_CERT_PATH: Joi.string().required(),
    LND_MACAROON_PATH: Joi.string().required(),
    PORT: Joi.number().default(3000),
});
