import {blockhash, lamports} from '@solana/kit';
import {stringifyJsonWithBigInts} from '@solana/rpc-spec-types';
import {expect} from 'chai';

import {
  Connection,
  type AccountsModeBlockResponse,
  type BlockResponse,
  type BlockSubscriptionAccountsModeBlockResponse,
  type BlockSubscriptionBase58BlockResponse,
  type BlockSubscriptionBase64BlockResponse,
  type BlockSubscriptionJsonBlockResponse,
  type BlockSubscriptionJsonParsedBlockResponse,
  type ParsedAccountsModeBlockResponse,
  type ParsedBlockResponse,
  type VersionedAccountsModeBlockResponse,
  type VersionedBlockResponse,
} from '../src';
import {
  emitHarnessEvent,
  stubSubscriptionHarness,
  teardownSubscriptions,
} from './mocks/rpc-subscriptions';

type BlockMeta<TBlock extends {transactions: ReadonlyArray<{meta: unknown}>}> =
  NonNullable<TBlock['transactions'][number]['meta']>;

type FullBlockMeta = BlockMeta<BlockResponse> &
  BlockMeta<VersionedBlockResponse> &
  BlockMeta<ParsedBlockResponse> &
  BlockMeta<BlockSubscriptionBase58BlockResponse> &
  BlockMeta<BlockSubscriptionBase64BlockResponse> &
  BlockMeta<BlockSubscriptionJsonBlockResponse> &
  BlockMeta<BlockSubscriptionJsonParsedBlockResponse>;

type AccountsBlockMeta = BlockMeta<AccountsModeBlockResponse> &
  BlockMeta<VersionedAccountsModeBlockResponse> &
  BlockMeta<ParsedAccountsModeBlockResponse> &
  BlockMeta<BlockSubscriptionAccountsModeBlockResponse>;

const ADDRESS = '11111111111111111111111111111111';
const requiredMeta = {
  err: null,
  fee: lamports(5000n),
  logMessages: null,
  postBalances: [lamports(5000n)],
  preBalances: [lamports(10000n)],
  rewards: null,
  status: {Ok: null},
};

const metadataCases = [
  {
    name: 'null',
    full: {
      ...requiredMeta,
      innerInstructions: null,
      postTokenBalances: null,
      preTokenBalances: null,
    } satisfies FullBlockMeta,
    accounts: {
      ...requiredMeta,
      postTokenBalances: null,
      preTokenBalances: null,
    } satisfies AccountsBlockMeta,
  },
  {
    name: 'omitted',
    full: {...requiredMeta} satisfies FullBlockMeta,
    accounts: {...requiredMeta} satisfies AccountsBlockMeta,
  },
  {
    name: 'empty',
    full: {
      ...requiredMeta,
      innerInstructions: [],
      postTokenBalances: [],
      preTokenBalances: [],
    } satisfies FullBlockMeta,
    accounts: {
      ...requiredMeta,
      postTokenBalances: [],
      preTokenBalances: [],
    } satisfies AccountsBlockMeta,
  },
];

function createBlock(
  encoding: 'json' | 'jsonParsed' | 'base58' | 'base64',
  transactionDetails: 'full' | 'accounts',
  meta: FullBlockMeta | AccountsBlockMeta,
) {
  const account = {
    pubkey: ADDRESS,
    signer: true,
    source: 'transaction',
    writable: true,
  };
  return {
    blockHeight: null,
    blockTime: null,
    blockhash: blockhash(ADDRESS),
    parentSlot: 0n,
    previousBlockhash: blockhash(ADDRESS),
    rewards: [],
    transactions: [
      {
        meta,
        transaction:
          encoding === 'base58' || encoding === 'base64'
            ? [encoding === 'base58' ? 'Ldp' : 'AQID', encoding]
            : {
                signatures: ['1'.repeat(64)],
                ...(transactionDetails === 'accounts'
                  ? {accountKeys: [account]}
                  : {
                      message: {
                        accountKeys:
                          encoding === 'json' ? [ADDRESS] : [account],
                        ...(encoding === 'json'
                          ? {
                              header: {
                                numReadonlySignedAccounts: 0,
                                numReadonlyUnsignedAccounts: 0,
                                numRequiredSignatures: 1,
                              },
                            }
                          : {}),
                        instructions: [],
                        recentBlockhash: ADDRESS,
                      },
                    }),
              },
        version: 'legacy',
      },
    ],
  };
}

function expectMetadataFields(
  meta: object | null | undefined,
  source: FullBlockMeta | AccountsBlockMeta,
  includeInnerInstructions = true,
) {
  expect(meta).not.to.equal(null);
  for (const key of [
    'innerInstructions',
    'postTokenBalances',
    'preTokenBalances',
  ] as const) {
    if (key === 'innerInstructions' && !includeInnerInstructions) continue;
    if (Object.hasOwn(source, key)) {
      expect(meta)
        .to.have.own.property(key)
        .that.deep.equals(Reflect.get(source, key));
    } else {
      expect(meta).not.to.have.property(key);
    }
  }
}

describe('block metadata contract', () => {
  for (const {name, full, accounts} of metadataCases) {
    for (const maxSupportedTransactionVersion of [undefined, 0] as const) {
      for (const method of ['getBlock', 'getParsedBlock'] as const) {
        for (const transactionDetails of ['full', 'accounts'] as const) {
          it(`${method}/${transactionDetails}/${maxSupportedTransactionVersion ?? 'legacy'} preserves ${name} array metadata`, async () => {
            const source = transactionDetails === 'full' ? full : accounts;
            const block = createBlock(
              method === 'getBlock' ? 'json' : 'jsonParsed',
              transactionDetails,
              source,
            );
            const connection = new Connection('http://mock.invalid', {
              commitment: 'confirmed',
              fetch: (_url, init) => {
                const request = JSON.parse(String(init?.body));
                expect(request.method).to.equal('getBlock');
                return Promise.resolve(
                  new Response(
                    stringifyJsonWithBigInts({
                      id: request.id,
                      jsonrpc: '2.0',
                      result: block,
                    }),
                  ),
                );
              },
            });

            const result = await connection[method](1, {
              ...(maxSupportedTransactionVersion === undefined
                ? {}
                : {maxSupportedTransactionVersion}),
              transactionDetails,
            });

            expectMetadataFields(
              result?.transactions[0].meta,
              source,
              method === 'getBlock',
            );
          });
        }
      }

      for (const mode of [
        'json',
        'jsonParsed',
        'base58',
        'base64',
        'accounts',
      ] as const) {
        it(`onBlock/${mode}/${maxSupportedTransactionVersion ?? 'legacy'} preserves ${name} array metadata`, async () => {
          const {connection, harness} = stubSubscriptionHarness(
            'http://mock.invalid',
            'confirmed',
          );
          harness.requestSubscription.resolves(1);
          harness.unsubscribe.resolves(true);
          const source = mode === 'accounts' ? accounts : full;
          let callbackCount = 0;
          const callback = (value: {
            block: {transactions: ReadonlyArray<{meta: object | null}>} | null;
          }) => {
            expectMetadataFields(value.block?.transactions[0].meta, source);
            callbackCount++;
          };

          try {
            const versionConfig =
              maxSupportedTransactionVersion === undefined
                ? {}
                : {maxSupportedTransactionVersion};
            const clientId =
              mode === 'accounts'
                ? connection.onBlock('all', callback, {
                    transactionDetails: 'accounts',
                    ...versionConfig,
                  })
                : mode === 'json'
                  ? connection.onBlock('all', callback, {
                      encoding: 'json',
                      ...versionConfig,
                    })
                  : mode === 'jsonParsed'
                    ? connection.onBlock('all', callback, {
                        encoding: 'jsonParsed',
                        ...versionConfig,
                      })
                    : mode === 'base58'
                      ? connection.onBlock('all', callback, {
                          encoding: 'base58',
                          ...versionConfig,
                        })
                      : connection.onBlock('all', callback, {
                          encoding: 'base64',
                          ...versionConfig,
                        });
            await new Promise<void>(resolve => setImmediate(resolve));

            emitHarnessEvent(harness, 'blockNotification', {
              result: {
                context: {slot: 1n},
                value: {
                  block: createBlock(
                    mode === 'accounts' ? 'json' : mode,
                    mode === 'accounts' ? 'accounts' : 'full',
                    source,
                  ),
                  err: null,
                  slot: 1n,
                },
              },
              subscription: 1,
            });

            expect(callbackCount).to.equal(1);
            await connection.removeBlockListener(clientId);
          } finally {
            await teardownSubscriptions(connection);
          }
        });
      }
    }
  }
});
