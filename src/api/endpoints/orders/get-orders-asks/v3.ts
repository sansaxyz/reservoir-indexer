/* eslint-disable @typescript-eslint/no-explicit-any */

import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@reservoir0x/sdk";
import Joi from "joi";
import _ from "lodash";

import { redb } from "@/common/db";
import { logger } from "@/common/logger";
import { JoiPrice, getJoiPriceObject } from "@/common/joi";
import {
  buildContinuation,
  fromBuffer,
  getNetAmount,
  regex,
  splitContinuation,
  toBuffer,
} from "@/common/utils";
import { config } from "@/config/index";
import { Sources } from "@/models/sources";
import { SourcesEntity } from "@/models/sources/sources-entity";

const version = "v3";

export const getOrdersAsksV3Options: RouteOptions = {
  description: "Asks (listings)",
  notes:
    "Get a list of asks (listings), filtered by token, collection or maker. This API is designed for efficiently ingesting large volumes of orders, for external processing",
  tags: ["api", "Orders"],
  plugins: {
    "hapi-swagger": {
      order: 5,
    },
  },
  validate: {
    query: Joi.object({
      ids: Joi.alternatives(Joi.string(), Joi.array().items(Joi.string())).description(
        "Order id(s) to search for."
      ),
      token: Joi.string()
        .lowercase()
        .pattern(regex.token)
        .description(
          "Filter to a particular token. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:123`"
        ),
      maker: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .description(
          "Filter to a particular user. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
        ),
      contracts: Joi.alternatives()
        .try(
          Joi.array().max(50).items(Joi.string().lowercase().pattern(regex.address)),
          Joi.string().lowercase().pattern(regex.address)
        )
        .description(
          "Filter to an array of contracts. Example: `0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63`"
        ),
      status: Joi.string()
        .valid("active", "inactive")
        .description(
          "active = currently valid, inactive = temporarily invalid\n\nAvailable when filtering by maker, otherwise only valid orders will be returned"
        ),
      includePrivate: Joi.boolean()
        .default(false)
        .description("If true, private orders are included in the response."),
      includeMetadata: Joi.boolean()
        .default(false)
        .description("If true, metadata is included in the response."),
      includeRawData: Joi.boolean()
        .default(false)
        .description("If true, raw data is included in the response."),
      sortBy: Joi.string()
        .when("token", {
          is: Joi.exist(),
          then: Joi.valid("price", "createdAt"),
          otherwise: Joi.valid("createdAt"),
        })
        .default("createdAt")
        .description("Order the items are returned in the response."),
      continuation: Joi.string()
        .pattern(regex.base64)
        .description("Use continuation token to request next offset of items."),
      limit: Joi.number()
        .integer()
        .min(1)
        .max(1000)
        .default(50)
        .description("Amount of items returned in response."),
    })
      .or("ids", "token", "contracts", "maker")
      .with("status", "maker"),
  },
  response: {
    schema: Joi.object({
      orders: Joi.array().items(
        Joi.object({
          id: Joi.string().required(),
          kind: Joi.string().required(),
          side: Joi.string().valid("buy", "sell").required(),
          tokenSetId: Joi.string().required(),
          tokenSetSchemaHash: Joi.string().lowercase().pattern(regex.bytes32).required(),
          contract: Joi.string().lowercase().pattern(regex.address),
          maker: Joi.string().lowercase().pattern(regex.address).required(),
          taker: Joi.string().lowercase().pattern(regex.address).required(),
          price: JoiPrice,
          validFrom: Joi.number().required(),
          validUntil: Joi.number().required(),
          metadata: Joi.alternatives(
            Joi.object({
              kind: "token",
              data: Joi.object({
                collectionName: Joi.string().allow("", null),
                tokenName: Joi.string().allow("", null),
                image: Joi.string().allow("", null),
              }),
            }),
            Joi.object({
              kind: "collection",
              data: Joi.object({
                collectionName: Joi.string().allow("", null),
                image: Joi.string().allow("", null),
              }),
            }),
            Joi.object({
              kind: "attribute",
              data: Joi.object({
                collectionName: Joi.string().allow("", null),
                attributes: Joi.array().items(
                  Joi.object({ key: Joi.string(), value: Joi.string() })
                ),
                image: Joi.string().allow("", null),
              }),
            })
          )
            .allow(null)
            .optional(),
          status: Joi.string(),
          source: Joi.object().allow(null),
          feeBps: Joi.number().allow(null),
          feeBreakdown: Joi.array()
            .items(
              Joi.object({
                kind: Joi.string(),
                recipient: Joi.string().allow("", null),
                bps: Joi.number(),
              })
            )
            .allow(null),
          expiration: Joi.number().required(),
          createdAt: Joi.string().required(),
          updatedAt: Joi.string().required(),
          rawData: Joi.object().optional(),
        })
      ),
      continuation: Joi.string().pattern(regex.base64).allow(null),
    }).label(`getOrdersAsks${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-orders-asks-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const query = request.query as any;

    try {
      const metadataBuildQuery = `
        (
          CASE
            WHEN orders.token_set_id LIKE 'token:%' THEN
              (SELECT
                json_build_object(
                  'kind', 'token',
                  'data', json_build_object(
                    'collectionName', collections.name,
                    'tokenName', tokens.name,
                    'image', tokens.image
                  )
                )
              FROM tokens
              JOIN collections
                ON tokens.collection_id = collections.id
              WHERE tokens.contract = decode(substring(split_part(orders.token_set_id, ':', 2) from 3), 'hex')
                AND tokens.token_id = (split_part(orders.token_set_id, ':', 3)::NUMERIC(78, 0)))

            WHEN orders.token_set_id LIKE 'contract:%' THEN
              (SELECT
                json_build_object(
                  'kind', 'collection',
                  'data', json_build_object(
                    'collectionName', collections.name,
                    'image', (collections.metadata ->> 'imageUrl')::TEXT
                  )
                )
              FROM collections
              WHERE collections.id = substring(orders.token_set_id from 10))

            WHEN orders.token_set_id LIKE 'range:%' THEN
              (SELECT
                json_build_object(
                  'kind', 'collection',
                  'data', json_build_object(
                    'collectionName', collections.name,
                    'image', (collections.metadata ->> 'imageUrl')::TEXT
                  )
                )
              FROM collections
              WHERE collections.id = substring(orders.token_set_id from 7))

            WHEN orders.token_set_id LIKE 'list:%' THEN
              (SELECT
                json_build_object(
                  'kind', 'attribute',
                  'data', json_build_object(
                    'collectionName', collections.name,
                    'attributes', ARRAY[json_build_object('key', attribute_keys.key, 'value', attributes.value)],
                    'image', (collections.metadata ->> 'imageUrl')::TEXT
                  )
                )
              FROM token_sets
              JOIN attributes
                ON token_sets.attribute_id = attributes.id
              JOIN attribute_keys
                ON attributes.attribute_key_id = attribute_keys.id
              JOIN collections
                ON attribute_keys.collection_id = collections.id
              WHERE token_sets.id = orders.token_set_id)

            ELSE NULL
          END
        ) AS metadata
      `;

      let baseQuery = `
        SELECT
          orders.id,
          orders.kind,
          orders.side,
          orders.token_set_id,
          orders.token_set_schema_hash,
          orders.contract,
          orders.maker,
          orders.taker,
          orders.currency,
          orders.price,
          orders.value,
          orders.currency_price,
          orders.currency_value,
          DATE_PART('epoch', LOWER(orders.valid_between)) AS valid_from,
          COALESCE(
            NULLIF(DATE_PART('epoch', UPPER(orders.valid_between)), 'Infinity'),
            0
          ) AS valid_until,
          orders.source_id_int,
          orders.fee_bps,
          orders.fee_breakdown,
          COALESCE(
            NULLIF(DATE_PART('epoch', orders.expiration), 'Infinity'),
            0
          ) AS expiration,
          extract(epoch from orders.created_at) AS created_at,
          (
            CASE
              WHEN orders.fillability_status = 'filled' THEN 'filled'
              WHEN orders.fillability_status = 'cancelled' THEN 'cancelled'
              WHEN orders.fillability_status = 'expired' THEN 'expired'
              WHEN orders.fillability_status = 'no-balance' THEN 'inactive'
              WHEN orders.approval_status = 'no-approval' THEN 'inactive'
              ELSE 'active'
            END
          ) AS status,
          orders.updated_at
          ${query.includeRawData ? ", orders.raw_data" : ""}
          ${query.includeMetadata ? `, ${metadataBuildQuery}` : ""}
        FROM orders
      `;

      // Filters
      const conditions: string[] = [`orders.side = 'sell'`];
      let orderStatusFilter = `orders.fillability_status = 'fillable' AND orders.approval_status = 'approved'`;

      if (query.ids) {
        if (Array.isArray(query.ids)) {
          conditions.push(`orders.id IN ($/ids:csv/)`);
        } else {
          conditions.push(`orders.id = $/ids/`);
        }
      }

      if (query.token) {
        (query as any).tokenSetId = `token:${query.token}`;
        conditions.push(`orders.token_set_id = $/tokenSetId/`);
      }

      if (query.contracts) {
        if (!_.isArray(query.contracts)) {
          query.contracts = [query.contracts];
        }

        for (const contract of query.contracts) {
          const contractsFilter = `'${_.replace(contract, "0x", "\\x")}'`;

          if (_.isUndefined((query as any).contractsFilter)) {
            (query as any).contractsFilter = [];
          }

          (query as any).contractsFilter.push(contractsFilter);
        }

        (query as any).contractsFilter = _.join((query as any).contractsFilter, ",");

        conditions.push(`orders.contract IN ($/contractsFilter:raw/)`);
      }

      if (query.maker) {
        switch (query.status) {
          case "inactive": {
            // Potentially-valid orders
            orderStatusFilter = `orders.fillability_status = 'no-balance' OR (orders.fillability_status = 'fillable' AND orders.approval_status != 'approved')`;
            break;
          }
        }

        (query as any).maker = toBuffer(query.maker);
        conditions.push(`orders.maker = $/maker/`);
      }

      if (!query.includePrivate) {
        conditions.push(
          `orders.taker = '\\x0000000000000000000000000000000000000000' OR orders.taker IS NULL`
        );
      }

      conditions.push(orderStatusFilter);

      if (query.continuation) {
        const [priceOrCreatedAt, id] = splitContinuation(
          query.continuation,
          /^\d+(.\d+)?_0x[a-f0-9]{64}$/
        );
        (query as any).priceOrCreatedAt = priceOrCreatedAt;
        (query as any).id = id;

        if (query.sortBy === "price") {
          conditions.push(`(orders.price, orders.id) > ($/priceOrCreatedAt/, $/id/)`);
        } else {
          conditions.push(
            `(orders.created_at, orders.id) < (to_timestamp($/priceOrCreatedAt/), $/id/)`
          );
        }
      }
      if (conditions.length) {
        baseQuery += " WHERE " + conditions.map((c) => `(${c})`).join(" AND ");
      }

      // Sorting
      if (query.sortBy === "price") {
        baseQuery += ` ORDER BY orders.price, orders.id`;
      } else {
        baseQuery += ` ORDER BY orders.created_at DESC, orders.id DESC`;
      }

      // HACK: Maximum limit is 100
      query.limit = Math.min(query.limit, 100);

      // Pagination
      baseQuery += ` LIMIT $/limit/`;

      const rawResult = await redb.manyOrNone(baseQuery, query);

      let continuation = null;
      if (rawResult.length === query.limit) {
        if (query.sortBy === "price") {
          continuation = buildContinuation(
            rawResult[rawResult.length - 1].price + "_" + rawResult[rawResult.length - 1].id
          );
        } else {
          continuation = buildContinuation(
            rawResult[rawResult.length - 1].created_at + "_" + rawResult[rawResult.length - 1].id
          );
        }
      }

      const sources = await Sources.getInstance();
      const result = rawResult.map(async (r) => {
        let source: SourcesEntity | undefined;
        if (r.token_set_id?.startsWith("token")) {
          const [, contract, tokenId] = r.token_set_id.split(":");
          source = sources.get(Number(r.source_id_int), contract, tokenId);
        } else {
          source = sources.get(Number(r.source_id_int));
        }

        return {
          id: r.id,
          kind: r.kind,
          side: r.side,
          status: r.status,
          tokenSetId: r.token_set_id,
          tokenSetSchemaHash: fromBuffer(r.token_set_schema_hash),
          contract: fromBuffer(r.contract),
          maker: fromBuffer(r.maker),
          taker: fromBuffer(r.taker),
          price: await getJoiPriceObject(
            {
              gross: {
                amount: r.currency_price ?? r.price,
                nativeAmount: r.price,
              },
              net: {
                amount: getNetAmount(r.currency_price ?? r.price, r.fee_bps),
                nativeAmount: getNetAmount(r.price, r.fee_bps),
              },
            },
            r.currency
              ? fromBuffer(r.currency)
              : r.side === "sell"
              ? Sdk.Common.Addresses.Eth[config.chainId]
              : Sdk.Common.Addresses.Weth[config.chainId]
          ),
          validFrom: Number(r.valid_from),
          validUntil: Number(r.valid_until),
          metadata: query.includeMetadata ? r.metadata : undefined,
          source: {
            id: source?.address,
            name: source?.metadata.title || source?.name,
            icon: source?.metadata.icon,
            url: source?.metadata.url,
          },
          feeBps: Number(r.fee_bps),
          feeBreakdown: r.fee_breakdown,
          expiration: Number(r.expiration),
          createdAt: new Date(r.created_at * 1000).toISOString(),
          updatedAt: new Date(r.updated_at).toISOString(),
          rawData: query.includeRawData ? r.raw_data : undefined,
        };
      });

      return {
        orders: await Promise.all(result),
        continuation,
      };
    } catch (error) {
      logger.error(`get-orders-asks-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};