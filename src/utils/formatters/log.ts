import {
  DecodeLogDataMismatch,
  DecodeLogTopicsMismatch,
} from '../../errors/abi.js'
import type { Log } from '../../types/log.js'
import type { RpcLog } from '../../types/rpc.js'
import { decodeEventLog } from '../abi/decodeEventLog.js'
import type { AbiEvent } from 'abitype'

export function decodeRpcLog(
  log: RpcLog,
  { event, strict }: { event?: AbiEvent; strict?: boolean } = {},
) {
  try {
    const { eventName, args } = event
      ? decodeEventLog({
          abi: [event] as [AbiEvent],
          data: log.data,
          topics: log.topics as any,
          strict,
        })
      : { eventName: undefined, args: undefined }
    return formatLog(log, { args, eventName })
  } catch (err) {
    let eventName
    let isUnnamed
    if (
      err instanceof DecodeLogDataMismatch ||
      err instanceof DecodeLogTopicsMismatch
    ) {
      // If strict mode is on, and log data/topics do not match event definition, skip.
      if (strict) return
      eventName = err.abiItem.name
      isUnnamed = err.abiItem.inputs?.some((x) => !('name' in x && x.name))
    }

    // Set args to empty if there is an error decoding (e.g. indexed/non-indexed params mismatch).
    return formatLog(log, { args: isUnnamed ? [] : {}, eventName })
  }
}

export function formatLog(
  log: Partial<RpcLog>,
  { args, eventName }: { args?: unknown; eventName?: string } = {},
) {
  return {
    ...log,
    blockHash: log.blockHash ? log.blockHash : null,
    blockNumber: log.blockNumber ? BigInt(log.blockNumber) : null,
    logIndex: log.logIndex ? Number(log.logIndex) : null,
    transactionHash: log.transactionHash ? log.transactionHash : null,
    transactionIndex: log.transactionIndex
      ? Number(log.transactionIndex)
      : null,
    ...(eventName ? { args, eventName } : {}),
  } as Log
}
