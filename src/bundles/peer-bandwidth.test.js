/* global it, expect */
import { composeBundlesRaw, createReactorBundle } from 'redux-bundler'
import createPeerBandwidthBundle from './peer-bandwidth.js'
import { fakeCid } from '../../test/helpers/cid.js'
import { randomInt } from '../../test/helpers/random.js'
import sleep from '../../test/helpers/sleep.js'
import { fakeBandwidth } from '../../test/helpers/bandwidth.js'
import { base58btc } from 'multiformats/bases/base58'

async function fakePeer () {
  const cid = await fakeCid()
  const peer = base58btc.encode(cid.multihash.bytes)

  return { peer }
}

const fakePeers = (count = 5) => Promise.all(Array(count).fill(0).map(fakePeer))

function createMockIpfsBundle (ipfs) {
  return {
    name: 'ipfs',
    getExtraArgs: () => ({ getIpfs: () => ipfs }),
    selectIpfsReady: () => true
  }
}

const mockPeersBundle = {
  name: 'peers',
  reducer (state = { data: [] }, action) {
    return action.type === 'UPDATE_MOCK_PEERS'
      ? { ...state, data: action.payload }
      : state
  },
  selectPeers: state => state.peers.data,
  doUpdateMockPeers: data => ({ dispatch }) => {
    dispatch({ type: 'UPDATE_MOCK_PEERS', payload: data })
  }
}

const mockRoutesBundle = { name: 'routes', selectRouteInfo: _ => ({ url: '/' }) }

const createMockIpfs = (opts) => {
  opts = opts || {}
  opts.minLatency = opts.minLatency || 1
  opts.maxLatency = opts.maxLatency || 100

  return {
    stats: {
      bw: async function * () {
        const bw = await new Promise(resolve => setTimeout(() => resolve(fakeBandwidth()), randomInt(opts.minLatency, opts.maxLatency)))
        yield bw
      }
    }
  }
}

it('should sync added peers', async () => {
  const store = composeBundlesRaw(
    createReactorBundle(),
    mockRoutesBundle,
    createMockIpfsBundle(createMockIpfs()),
    mockPeersBundle,
    createPeerBandwidthBundle()
  )()

  const peers = store.selectPeers()
  expect(peers).toEqual([])

  let bwPeers = store.selectPeerBandwidthPeers()
  expect(bwPeers).toEqual([])

  const totalPeers = randomInt(1, 100)
  const nextPeers = await fakePeers(totalPeers)

  // Add the peers
  store.doUpdateMockPeers(nextPeers)
  await sleep() // Wait for the reactions to happen
  bwPeers = store.selectPeerBandwidthPeers()

  expect(bwPeers.length).toBe(totalPeers)

  bwPeers.forEach(({ id }) => {
    expect(nextPeers.some(p => p.peer === id)).toBe(true)
  })
})

it('should sync removed peers', async () => {
  const totalPeers = randomInt(2, 100)
  const peers = await fakePeers(totalPeers)

  const store = composeBundlesRaw(
    createReactorBundle(),
    mockRoutesBundle,
    createMockIpfsBundle(createMockIpfs()),
    mockPeersBundle,
    createPeerBandwidthBundle()
  )({
    peers: { data: peers }
  })

  // Wait for the bundle to initially sync peers
  await sleep()

  expect(store.selectPeers()).toEqual(peers)

  let bwPeers = store.selectPeerBandwidthPeers()
  expect(bwPeers.length).toBe(peers.length)

  bwPeers.forEach(({ id }) => {
    expect(peers.some(p => p.peer === id)).toBe(true)
  })

  const nextTotalPeers = randomInt(1, totalPeers)
  const nextPeers = peers.slice(0, nextTotalPeers)

  // Remove the peers
  store.doUpdateMockPeers(nextPeers)
  await sleep(50)
  bwPeers = store.selectPeerBandwidthPeers()

  expect(bwPeers.length).toBe(nextPeers.length)

  bwPeers.forEach(({ id }) => {
    expect(nextPeers.some(p => p.peer === id)).toBe(true)
  })
})

it('should sync added and removed peers', async () => {
  const totalPeers = randomInt(2, 100)
  const peers = await fakePeers(totalPeers)

  const store = composeBundlesRaw(
    createReactorBundle(),
    mockRoutesBundle,
    createMockIpfsBundle(createMockIpfs()),
    mockPeersBundle,
    createPeerBandwidthBundle()
  )({
    peers: { data: peers }
  })

  // Wait for the bundle to initially sync peers
  await sleep()

  expect(store.selectPeers()).toEqual(peers)

  let bwPeers = store.selectPeerBandwidthPeers()
  expect(bwPeers.length).toBe(peers.length)

  bwPeers.forEach(({ id }) => {
    expect(peers.some(p => p.peer === id)).toBe(true)
  })

  const totalAddedPeers = randomInt(1, 100)
  const totalRemovedPeers = randomInt(1, totalPeers)

  const nextPeers = peers
    .slice(0, totalRemovedPeers)
    .concat(await fakePeers(totalAddedPeers))

  // Add and remove the peers
  store.doUpdateMockPeers(nextPeers)
  while (store.selectPeerBandwidthPeers().length !== nextPeers.length) {
    // flaky test, failure will show as a timeout error
    await sleep()
  }
  bwPeers = store.selectPeerBandwidthPeers()

  expect(bwPeers.length).toBe(nextPeers.length)

  bwPeers.forEach(({ id }) => {
    expect(nextPeers.some(p => p.peer === id)).toBe(true)
  })
})

it('should get bandwidth for added peers', async () => {
  const totalPeers = randomInt(1, 5)
  const peers = await fakePeers(totalPeers)

  const store = composeBundlesRaw(
    createReactorBundle(),
    mockRoutesBundle,
    // This IPFS takes at minimum 20ms to respond to a function call
    createMockIpfsBundle(createMockIpfs({ minLatency: 20, maxLatency: 30 })),
    mockPeersBundle,
    // Up the concurrency value for the bundle so all the bandwidth updates
    // are fired off at the same time
    createPeerBandwidthBundle({ peerUpdateConcurrency: totalPeers + 1 })
  )({
    peers: { data: peers }
  })

  // Wait for the bundle to initially sync peers
  await sleep(10)

  // Now the peers should be synced, but not yet updated with bandwidth stats
  let bwPeers = store.selectPeerBandwidthPeers()
  expect(bwPeers.length).toBe(peers.length)

  bwPeers.forEach(({ bw }) => expect(bw).toBeFalsy())

  // Wait for all the bandwdith stats to come in
  while (bwPeers.some(p => typeof p.bw === 'undefined')) {
    await sleep(30)
    bwPeers = store.selectPeerBandwidthPeers()
  }

  // Now all the peers should have had their bandwidth updated
  expect(bwPeers.length).toBe(peers.length)

  bwPeers.forEach(({ bw }) => expect(bw).toBeTruthy())
})

it('should periodically update bandwidth for peers', async () => {
  const totalPeers = randomInt(1, 2)
  const peers = await fakePeers(totalPeers)

  const store = composeBundlesRaw(
    createReactorBundle(),
    mockRoutesBundle,
    createMockIpfsBundle(createMockIpfs({ minLatency: 0, maxLatency: 1 })),
    mockPeersBundle,
    // Up the concurrency value for the bundle so all the bandwidth updates
    // are fired off at the same time
    createPeerBandwidthBundle({
      peerUpdateConcurrency: totalPeers + 1,
      tickResolution: 100,
      peerUpdateInterval: 50
    })
  )({
    peers: { data: peers }
  })

  await sleep(50)

  // Now all the peers should be synced and have had their bandwidth updated
  const bwPeers = store.selectPeerBandwidthPeers()
  expect(bwPeers.length).toBe(peers.length)

  bwPeers.forEach(({ bw }) => expect(bw).toBeTruthy())

  await sleep(100)
  store.dispatch({ type: 'APP_IDLE' })
  await sleep(50)

  // Now all the peers should have had their bandwidth updated
  const nextBwPeers = store.selectPeerBandwidthPeers()

  nextBwPeers.forEach(nextPeer => {
    const peer = bwPeers.find(p => p.id === nextPeer.id)
    expect(peer).toBeTruthy()
    expect(nextPeer.bw).toBeTruthy()
    expect(peer.lastSuccess).not.toBe(nextPeer.lastSuccess)
    expect(peer.bw.totalIn.eq(nextPeer.bw.totalIn)).toBe(false)
    expect(peer.bw.totalOut.eq(nextPeer.bw.totalOut)).toBe(false)
    expect(peer.bw.rateIn.eq(nextPeer.bw.rateIn)).toBe(false)
    expect(peer.bw.rateOut.eq(nextPeer.bw.rateOut)).toBe(false)
  })
})

describe('should update peer bandwidth according to concurrency option', () => {
  for (let peerUpdateConcurrency = 1; peerUpdateConcurrency <= 5; peerUpdateConcurrency++) {
    it(`peerUpdateConcurrency=${peerUpdateConcurrency}`, async () => {
      const totalPeers = randomInt(5, 10)
      const peers = await fakePeers(totalPeers)
      const reducerCallLog = []
      const store = composeBundlesRaw(
        createReactorBundle(),
        mockRoutesBundle,
        createMockIpfsBundle(createMockIpfs({ minLatency: 100, maxLatency: 150 })),
        mockPeersBundle,
        new Proxy(createPeerBandwidthBundle({ peerUpdateConcurrency }), {
          get: (target, prop) => {
            if (prop === 'reducer') {
              const origReducer = target[prop]
              return (state, action) => {
                const result = origReducer(state, action)
                reducerCallLog.push({ action, result })
                return result
              }
            }
            return target[prop]
          }
        })
      )({
        peers: { data: peers }
      })

      let allPeersHaveBw = false
      while(allPeersHaveBw === false) {
        // ensure all peers are updated before continuing.
        await sleep(50)
        if (store.selectPeerBandwidthPeers().every(p => p.bw)) {
          allPeersHaveBw = true
        }
      }
      let maxInFlight = 0
      let inFlight = 0
      /**
       * ensure that there were never any more than `peerUpdateConcurrency` count of `UPDATE_PEER_BANDWIDTH_STARTED` action types dispatched
       * before a `UPDATE_PEER_BANDWIDTH_FINISHED` action type was dispatched
       */
      for (const { action } of reducerCallLog) {
        if (action.type === 'UPDATE_PEER_BANDWIDTH_STARTED') {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
        }
        if (action.type === 'UPDATE_PEER_BANDWIDTH_FINISHED') {
          inFlight--
        }
      }
      expect(maxInFlight).toBe(peerUpdateConcurrency)
    })
  }
})
