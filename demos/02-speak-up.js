const { interval, Observable, Subject, from } = require("rxjs")
const { flatMap, map, take, zip } = require("rxjs/operators")

const sayings = from(["International House of Pancakes", "Starbucks", "Dunkin"])

/*
    The flow of this demo is:
    - show a single spoken event
    - show sequentially processed overlapping events speak simultaneously
        (these are mode:sync handlers that kick off async processes)
    - discuss the implications of promisifying - argue you need
        a stream you can control instead
    - option A: If you had a promise for the handling, you could await it
*/
module.exports = ({ Agent, log, config }) => {
  const interactive = !!process.env.INTERACTIVE
  const infinite = !!process.env.INFINITE
  const { count = 2, concurrency = "parallel", tickInterval = 250 } = config
  // show elapsing of time in the log
  if (!interactive) {
    startTick(log, tickInterval)
  }

  return doIt()

  async function doIt() {
    let agent = new Agent()

    // This one speaks things
    agent.on(true, speakIt, { concurrency })

    // We don't await the processing of each event, but we
    // return a promise for the completion of all demos,
    // because the demo runner needs that to serialize demos.
    let allRenders = Promise.resolve()
    return getEvents(interactive)
      .pipe(
        flatMap(event => {
          log(`> Processing event: Say.speak("${event.payload.toSpeak}")`)
          let result = agent.process(event)
          log("< Done Processing")
          return result.completed.then(() => log("< Done speaking"))
        })
      )
      .toPromise()
  }

  function getEvents(interactive) {
    //return getDemoEvents() // XXX interactive mode is busted
    return interactive ? getUserEvents() : getDemoEvents()
  }

  // By returning an Observable, we can either hand back a static array
  // or an infinite stream over time (every 60 seconds)
  function getDemoEvents() {
    if (infinite) {
      const faker = require("faker")
      const controls = [
        map(() => ({
          payload: {
            toSpeak: faker.company.catchPhrase()
          }
        }))
      ]
      if (count) {
        controls.push(take(count))
      }
      return interval(1000).pipe(...controls)
    }

    return interval(250).pipe(
      zip(sayings, (_, toSpeak) => ({
        payload: {
          toSpeak
        }
      })),
      take(count)
    )
  }

  function getUserEvents() {
    const inquirer = require("inquirer")
    return from(
      inquirer
        .prompt([
          {
            name: "say1",
            message: "Type your 1st thing to say:"
          },
          {
            name: "say2",
            message: "Type your 2nd thing to say:"
          }
        ])
        .then(result => {
          startTick(log, tickInterval)
          return result
        })
        .then(({ say1, say2 }) => {
          return [
            {
              payload: {
                toSpeak: say1
              }
            },
            {
              payload: {
                toSpeak: say2
              }
            }
          ]
        })
    ).pipe(
      // expand these into their individual events
      flatMap(arr => from(arr))
      // space them out: zip 'waits' on its argument
      //zip(interval(tickInterval * 2), event => event)
    )
  }

  function startTick(log, interval) {
    // overall timing to show us where we're at and exit tidily
    let tick = setInterval(() => log("•"), interval)
    return new Promise(resolve =>
      setTimeout(() => {
        clearInterval(tick)
        resolve()
      }, 1500)
    )
  }

  // Return an observable that begins when subscribe is called,
  // and completes when say.speak ends
  function speakIt({ event }) {
    const { toSpeak } = event.payload

    // Remember: unlike Promises, which share a similar construction,
    // the observable function is not run until the Observable recieves
    // a subscribe() call.
    return new Observable(observer => {
      try {
        const say = require("say")
        say.speak(toSpeak, null, null, () => {
          observer.complete()
        })

        // An Observable allows for cancellation by returning a
        // cancellation function
        return () => {
          say.stop()
        }
      } catch (error) {
        log("-- speech synthesis not available --")
        observer.error()
      }
    })
  }
}
