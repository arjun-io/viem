import type { Abi, AbiEvent, Address, ExtractAbiEvent, Narrow } from 'abitype'

import type { PublicClient } from '../../clients/createPublicClient.js'
import type { Transport } from '../../clients/transports/createTransport.js'
import type { Chain } from '../../types/chain.js'
import type { GetEventArgs, InferEventName } from '../../types/contract.js'
import type { Filter } from '../../types/filter.js'
import type { Log } from '../../types/log.js'
import type { GetTransportConfig } from '../../types/transport.js'
import {
  type EncodeEventTopicsParameters,
  encodeEventTopics,
} from '../../utils/abi/encodeEventTopics.js'
import {
  type GetAbiItemParameters,
  getAbiItem,
} from '../../utils/abi/getAbiItem.js'
import { observe } from '../../utils/observe.js'
import { poll } from '../../utils/poll.js'
import { stringify } from '../../utils/stringify.js'

import { type LogTopic } from '../../index.js'
import type { RpcLog } from '../../index.js'
import { decodeRpcLog } from '../../utils/formatters/log.js'
import {
  type CreateContractEventFilterParameters,
  createContractEventFilter,
} from './createContractEventFilter.js'
import { getBlockNumber } from './getBlockNumber.js'
import { getFilterChanges } from './getFilterChanges.js'
import { type GetLogsParameters, getLogs } from './getLogs.js'
import { uninstallFilter } from './uninstallFilter.js'

type PollOptions = {
  /** Polling frequency (in ms). Defaults to the client's pollingInterval config. */
  pollingInterval?: number

  /** Whether or not the event logs should be batched on each invocation. */
  batch?: boolean
}

export type OnLogsParameter<
  TAbi extends Abi | readonly unknown[] = readonly unknown[],
  TEventName extends string = string,
  TStrict extends boolean | undefined = undefined,
> = TAbi extends Abi
  ? Log<bigint, number, ExtractAbiEvent<TAbi, TEventName>, TStrict>[]
  : Log[]
export type OnLogsFn<
  TAbi extends Abi | readonly unknown[] = readonly unknown[],
  TEventName extends string = string,
  TStrict extends boolean | undefined = undefined,
> = (logs: OnLogsParameter<TAbi, TEventName, TStrict>) => void

export type WatchContractEventParameters<
  TTransport extends Transport = Transport,
  TAbi extends Abi | readonly unknown[] = readonly unknown[],
  TEventName extends string = string,
  TStrict extends boolean | undefined = undefined,
> = {
  /** The address of the contract. */
  address?: Address | Address[]
  /** Contract ABI. */
  abi: Narrow<TAbi>
  args?: GetEventArgs<TAbi, TEventName>
  /** Contract event. */
  eventName?: InferEventName<TAbi, TEventName>
  /** The callback to call when an error occurred when trying to get for a new block. */
  onError?: (error: Error) => void
  /** The callback to call when new event logs are received. */
  onLogs: OnLogsFn<TAbi, TEventName, TStrict>
  /**
   * Whether or not the logs must match the indexed/non-indexed arguments on `event`.
   * @default false
   */
  strict?: TStrict
} & (GetTransportConfig<TTransport>['type'] extends 'webSocket'
  ?
      | {
          poll?: false
          batch?: never
          pollingInterval?: never
        }
      | (PollOptions & { poll?: true })
  : PollOptions & { poll?: true })

export type WatchContractEventReturnType = () => void

/**
 * Watches and returns emitted contract event logs.
 *
 * - Docs: https://viem.sh/docs/contract/watchContractEvent.html
 *
 * This Action will batch up all the event logs found within the [`pollingInterval`](https://viem.sh/docs/contract/watchContractEvent.html#pollinginterval-optional), and invoke them via [`onLogs`](https://viem.sh/docs/contract/watchContractEvent.html#onLogs).
 *
 * `watchContractEvent` will attempt to create an [Event Filter](https://viem.sh/docs/contract/createContractEventFilter.html) and listen to changes to the Filter per polling interval, however, if the RPC Provider does not support Filters (e.g. `eth_newFilter`), then `watchContractEvent` will fall back to using [`getLogs`](https://viem.sh/docs/actions/public/getLogs) instead.
 *
 * @param client - Client to use
 * @param parameters - {@link WatchContractEventParameters}
 * @returns A function that can be invoked to stop watching for new event logs. {@link WatchContractEventReturnType}
 *
 * @example
 * import { createPublicClient, http, parseAbi } from 'viem'
 * import { mainnet } from 'viem/chains'
 * import { watchContractEvent } from 'viem/contract'
 *
 * const client = createPublicClient({
 *   chain: mainnet,
 *   transport: http(),
 * })
 * const unwatch = watchContractEvent(client, {
 *   address: '0xFBA3912Ca04dd458c843e2EE08967fC04f3579c2',
 *   abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']),
 *   eventName: 'Transfer',
 *   args: { from: '0xc961145a54C96E3aE9bAA048c4F4D6b04C13916b' },
 *   onLogs: (logs) => console.log(logs),
 * })
 */
export function watchContractEvent<
  TTransport extends Transport,
  TChain extends Chain | undefined,
  TAbi extends Abi | readonly unknown[],
  TEventName extends string,
  TStrict extends boolean | undefined = undefined,
>(
  client: PublicClient<TTransport, TChain>,
  {
    abi,
    address,
    args,
    batch = true,
    eventName,
    onError,
    onLogs,
    poll: poll_,
    pollingInterval = client.pollingInterval,
    strict: strict_,
  }: WatchContractEventParameters<TTransport, TAbi, TEventName, TStrict>,
): WatchContractEventReturnType {
  const enablePolling =
    typeof poll_ !== 'undefined' ? poll_ : client.transport.type !== 'webSocket'
  const strict = strict_ ?? false

  const pollEvents = () => {
    const observerId = stringify([
      'watchContractEvent',
      address,
      args,
      batch,
      client.uid,
      eventName,
      pollingInterval,
    ])

    return observe(observerId, { onLogs, onError }, (emit) => {
      let previousBlockNumber: bigint
      let filter: Filter<'event', TAbi, TEventName> | undefined
      let initialized = false

      const unwatch = poll(
        async () => {
          if (!initialized) {
            try {
              filter = (await createContractEventFilter(client, {
                abi,
                address,
                args,
                eventName,
                strict,
              } as unknown as CreateContractEventFilterParameters)) as Filter<
                'event',
                TAbi,
                TEventName
              >
            } catch {}
            initialized = true
            return
          }

          try {
            let logs: Log[]
            if (filter) {
              logs = await getFilterChanges(client, { filter })
            } else {
              // If the filter doesn't exist, we will fall back to use `getLogs`.
              // The fall back exists because some RPC Providers do not support filters.

              // Fetch the block number to use for `getLogs`.
              const blockNumber = await getBlockNumber(client)

              // If the block number has changed, we will need to fetch the logs.
              // If the block number doesn't exist, we are yet to reach the first poll interval,
              // so do not emit any logs.
              if (previousBlockNumber && previousBlockNumber !== blockNumber) {
                logs = await getLogs(client, {
                  address,
                  args,
                  fromBlock: previousBlockNumber + 1n,
                  toBlock: blockNumber,
                  event: getAbiItem({
                    abi,
                    name: eventName,
                  } as unknown as GetAbiItemParameters),
                } as unknown as GetLogsParameters)
              } else {
                logs = []
              }
              previousBlockNumber = blockNumber
            }

            if (logs.length === 0) return
            if (batch) emit.onLogs(logs as any)
            else logs.forEach((log) => emit.onLogs([log] as any))
          } catch (err) {
            emit.onError?.(err as Error)
          }
        },
        {
          emitOnBegin: true,
          interval: pollingInterval,
        },
      )

      return async () => {
        if (filter) await uninstallFilter(client, { filter })
        unwatch()
      }
    })
  }

  const subscribeEvents = () => {
    let active = true
    let unsubscribe = () => {
      active = false
    }
    ;(async () => {
      try {
        const event = getAbiItem({
          abi,
          name: eventName,
        } as unknown as GetAbiItemParameters)
        let topics: LogTopic[] = []
        if (event)
          topics = encodeEventTopics({
            abi: [event],
            eventName: event.name,
            args,
          } as EncodeEventTopicsParameters)

        const { unsubscribe: unsubscribe_ } = await client.transport.subscribe({
          params: [
            'logs',
            {
              address,
              topics,
            },
          ],
          onData(log: RpcLog) {
            const decodedLog = decodeRpcLog(log, {
              event: event as AbiEvent,
              strict,
            })
            onLogs?.([decodedLog] as any)
          },
          onError(error: Error) {
            onError?.(error)
          },
        })
        unsubscribe = unsubscribe_
        if (!active) unsubscribe()
      } catch (err) {
        onError?.(err as Error)
      }
    })()
    return unsubscribe
  }

  return enablePolling ? pollEvents() : subscribeEvents()
}
