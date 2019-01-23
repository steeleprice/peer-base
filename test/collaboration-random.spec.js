/* eslint-env mocha */
'use strict'

const chai = require('chai')
chai.use(require('dirty-chai'))
const expect = chai.expect

const delay = require('delay')
const PeerStar = require('../')
const AppFactory = require('./utils/create-app')
const peerToClockId = require('../src/collaboration/peer-to-clock-id')

const debug = require('debug')('peer-base:test:collaboration-random')

describe('collaboration with random changes', function () {
  const peerCount = 15
  const charsPerPeer = process.browser ? 6 : 6
  this.timeout(10000 * peerCount)

  const manyCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'.split('')

  const collaborationOptions = {}

  let App
  let swarm = []
  let collaborations
  let collaborationIds = new Map()

  before(() => {
    const appName = AppFactory.createName()
    App = AppFactory(appName)
  })

  const peerIndexes = []
  for (let i = 0; i < peerCount; i++) {
    peerIndexes.push(i)
  }

  before(() => Promise.all(peerIndexes.map(() => {
    const app = App()
    swarm.push(app)
    return app.start()
  })))

  after(() => Promise.all(peerIndexes.map(async (peerIndex) => {
    return swarm[peerIndex] && swarm[peerIndex].stop()
  })))

  before(async () => {
    collaborationOptions.keys = await PeerStar.keys.generate()
  })

  it('can be created', async () => {
    collaborations = await Promise.all(
      swarm.map((peer) => peer.app.collaborate('test random collaboration', 'rga', collaborationOptions)))
    expect(collaborations.length).to.equal(peerCount)
    await Promise.all(collaborations.map(async c => {
      const id = (await c.app.ipfs.id()).id
      collaborationIds.set(c, id)
    }))
    // await waitForMembers(collaborations)
  })

  it('handles random changes', async () => {
    const expectedCharacterCount = charsPerPeer * collaborations.length
    const peerIds = [...collaborationIds.values()]
    const peerClockKeys = peerIds.map(peerToClockId).sort()

    const waitForHalfModifications = () => Promise.all(collaborations.map((collaboration) => new Promise((resolve) => {
      const expectedCount = Math.round(expectedCharacterCount / 2)
      const currentCount = collaboration.shared.value().length

      if (currentCount >= expectedCount) {
        return resolve()
      }

      const onStateChanged = () => {
        const currentCount = collaboration.shared.value().length
        if (currentCount >= expectedCount) {
          collaboration.removeListener('state changed', onStateChanged)
          resolve()
        }
      }

      collaboration.on('state changed', onStateChanged)
    })))

    const modifications = async (collaboration, i) => {
      const waitForCharCount = new Promise((resolve) => {
        if (collaboration.shared.value().length === expectedCharacterCount) {
          return resolve()
        }
        collaboration.on('state changed', () => {
          const currentCount = collaboration.shared.value().length
          if (currentCount === expectedCharacterCount) {
            resolve()
          }
        })
      })

      for (let j = 0; j < charsPerPeer; j++) {
        const character = characterFrom(manyCharacters, i * charsPerPeer + j)
        collaboration.shared.push(character)
        const id = collaborationIds.get(collaboration).slice(-3)
        debug(`Push: ${String(i).padStart(2)} ${id} ${j}`)
        if (i === Math.round(charsPerPeer / 2)) {
          await waitForHalfModifications()
        } else {
          await delay(randomShortTime())
        }
      }

      return waitForCharCount.then(async () => {
        debug('got state changes for', collaborationIds.get(collaboration))
      })
    }

    // Wait for all the state changes to come in
    debug('waiting for state changes')
    await Promise.all(collaborations.map(modifications))
    debug('got all state changes')

    // Wait for any remaining clocks to arrive
    if (checkAllClocks()) {
      debug('all clocks up to date')
    } else {
      debug('waiting for clocks')
      /*
      let count = 0
      await Promise.all(collaborations.map(async (collaboration) => {
        const collaborationPeerId = collaborationIds.get(collaboration)
        if (checkCollaborationClocks(collaboration)) {
          debug('got all clocks for %s (%d / %d)', collaborationPeerId, ++count, peerCount)
          return
        }
        return new Promise(resolve => {
          let complete = false
          collaboration._clocks.on('update', () => {
            if (complete) {
              return
            }
            if (checkCollaborationClocks(collaboration)) {
              complete = true
              debug('got all clocks for %s (%d / %d)', collaborationPeerId, ++count, peerCount)
              resolve()
            }
          })
        })
      }))
      */
      debug('got all clocks for all collaborations')
    }

    // The length of all collaborations should be the expected length
    for (let i = 0; i < collaborations.length; i++) {
      expect(collaborations[i].shared.value().length).to.equal(expectedCharacterCount)
    }

    // The value of all collaborations should be the same
    let count = 0
    for (const c of collaborations) {
      debug('Value', String(count++).padStart(2),
        collaborationIds.get(c).slice(-3),
        c.shared.value().join(''))
    }

    const expectedValue = collaborations[0].shared.value()
    for (const c of collaborations) {
      expect(c.shared.value()).to.eql(expectedValue)
    }

    // validate all vector clocks are correct
    for (let collaboration of collaborations) {
      const peerId = collaborationIds.get(collaboration)
      const clocks = collaboration.vectorClock(peerId)
      expect(Object.keys(clocks).length).to.equal(peerCount)
      for (let clock of Object.values(clocks)) {
        expect(clock).to.equal(charsPerPeer)
      }
    }

    function randomShortTime () {
      // return Math.floor(Math.random() * 10)
      // Range: 37ms to 2.5s ... use inverse log so mostly quick
      return Math.floor((1 / Math.log(Math.random() * 5 + 1.02) * 50) + 10)
    }

    function characterFrom (characters, index) {
      return characters[index % characters.length]
    }

    function checkCollaborationClocks (collaboration) {
      const collaborationPeerId = collaborationIds.get(collaboration)
      const collabPeerIdAsClockId = peerToClockId(collaborationPeerId)
      for (let peerId of peerIds) {
        const clock = Object.assign({}, collaboration.vectorClock(peerId))

        // Ignore own key because remote may not send us updates about ourself
        delete clock[collabPeerIdAsClockId]
        if (Object.keys(clock).length < peerCount - 1) {
          return false
        }
        for (let replica of peerClockKeys) {
          if (clock.hasOwnProperty(replica) && clock[replica] !== charsPerPeer) {
            return false
          }
        }
      }
      return true
    }

    function checkAllClocks () {
      for (let collaboration of collaborations) {
        if (!checkCollaborationClocks(collaboration)) {
          return false
        }
      }
      return true
    }
  })
})
