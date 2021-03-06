import {
  Observable,
  Subject,
  Subscription,
  animationFrameScheduler,
  from,
  of,
  interval,
  timer,
  never
} from "rxjs"
import { filter as rxFilter, map, takeUntil, first } from "rxjs/operators"
import {
  Evented,
  Event,
  EventMatcher,
  EventedItem,
  AgentConfig,
  Concurrency,
  ProcessResult,
  Subscriber,
  SubscribeConfig,
  HandlerConfig,
  StoreLike,
  AwaitableObservable
} from "./types"

export {
  Event,
  EventMatcher,
  AgentConfig,
  EventedItem,
  Concurrency,
  ProcessResult,
  Subscriber,
  HandlerConfig
} from "./types"

// Export utility rxjs operators and our own custom
export * from "./operators"
export { from, of, empty, concat, merge, interval, zip, Observable } from "rxjs"

// Leave this as require not import! https://github.com/webpack/webpack/issues/1019
const assert = typeof require === "undefined" ? () => null : require("assert")

/**
 * Represents an instance of an event bus which you trigger/process events
 * to, and listen via handlers attached via `filter`(sync) and `on`(async).
 * Handlers can emit further events, thus extending the process.
 *
 * A singleton instance is exported as `app`, and top-level `filter` `on`
 * `process` and `subscribe` are bound to it.
 */
export class Agent implements Evented {
  public static configurableProps = ["agentId"]
  public static VERSION = "2.1.5"

  private event$: Observable<EventedItem>
  [key: string]: any

  private _subscriberCount = 0
  private Evented: Subject<EventedItem>
  private allFilters: Map<string, Subscriber>
  private allHandlers: Map<string, Function>

  handlerNames() {
    return Array.from(this.allHandlers.keys())
  }
  filterNames() {
    return Array.from(this.allFilters.keys())
  }

  /**
   * Gets an Observable of all events matching the EventMatcher. */
  getAllEvents(matcher: EventMatcher) {
    const predicate = getEventPredicate(matcher)
    return this.event$.pipe(
      rxFilter(predicate),
      map(({ event }) => event)
    )
  }

  /**
   * Gets a promise for the next event matching the EventMatcher. */
  getNextEvent(matcher: EventMatcher = true) {
    const predicate = getEventPredicate(matcher)
    return this.event$
      .pipe(
        rxFilter(predicate),
        first(),
        map(({ event }) => event)
      )
      .toPromise()
  }

  constructor(config: AgentConfig = {}) {
    this.Evented = new Subject<EventedItem>()
    this.event$ = this.Evented.asObservable()
    this.allFilters = new Map<string, Subscriber>()
    this.allHandlers = new Map<string, Function>()
    config.agentId = config.agentId || randomId()
    for (let key of Object.keys(config)) {
      Agent.configurableProps.includes(key) &&
        Object.defineProperty(this, key.toString(), {
          value: config[key],
          writable: false,
          enumerable: true,
          configurable: false
        })
    }
  }

  /**
   * Process sends an event (eg Flux Standard Action), which
   * is an object with a payload and `type`, through the chain of
   * filters, and then triggers any applicable handlers.
   * @throws Throws if a filter errs, but not if a handler errs.
   * @see trigger
   */
  process(event: Event, context?: any): ProcessResult {
    // Execute all filters one after the other, synchronously, in the order added
    const filterResults = new Map<string, any>()
    const item: EventedItem = {
      event,
      type: event.type,
      payload: event.payload,
      results: filterResults
    }
    this.runFilters(item, filterResults)

    this.Evented.next(item)

    // Add readonly properties for each filter result
    // The return value of agent.process ducktypes the event,
    // plus some additional properties
    const resultObject = Object.assign({}, event)
    for (let [key, value] of filterResults) {
      Object.defineProperty(resultObject, key.toString(), {
        value,
        configurable: false,
        enumerable: true,
        writable: false
      })
    }

    const handlerPromises = new Map<string, Promise<any>>()
    for (let [name, handlerPromiser] of this.allHandlers) {
      handlerPromises.set(name, handlerPromiser(event, context))
    }

    // From the handlerPromises, create the Promise for an array of {name, resolvedValue} objects,
    // then reduce it to an object where the resolved values are keyed under the name
    const completedObject = Promise.all(
      Array.from(handlerPromises.keys()).map(name => {
        // @ts-ignore
        return handlerPromises.get(name).then(value => ({ name, resolvedValue: value }))
      })
    ).then(arrResults => {
      return arrResults.reduce((all, one) => {
        // @ts-ignore
        all[one.name] = one.resolvedValue
        return all
      }, {})
    })

    for (let name of handlerPromises.keys()) {
      Object.defineProperty(completedObject, name, {
        value: handlerPromises.get(name),
        configurable: false,
        enumerable: true,
        writable: false
      })
    }

    Object.defineProperty(resultObject, "completed", {
      value: completedObject,
      configurable: false,
      enumerable: true,
      writable: false
    })

    return resultObject
  }

  /**
   * Constructs an Event from the `type` and `payload` passed, and calls `process` with it.
   * @see process
   * */
  trigger(type: string, payload?: any, context?: any): ProcessResult {
    return this.process({ type, payload }, context)
  }

  /**
   * Handlers attached via `on` are functions that exist to create side-effects
   * outside of the Rx-Helper Agent. Handlers may make changes to a DOM, database,
   * or put messages (eg AJAX) onto the network.
   * Handlers specify the events they handle via an `EventMatcher`.
   * Handlers run in parallel with respect to other handlers, and are error-isolated.
   * They return Observables - an object that models a series of notifications over
   * time, much like Promise models a single result over some time.
   * Should they overlap, the `concurrency` config parameter controls whether they
   * run immediately, are queued, dropped, or replace the currently running one.
   *
   * Here we attach a handler to fire on events of `type: 'kickoff'`.
   * After 50ms, the agent will process `{ type: 'search', payload: '#go!' }`,
   * at which point the Promise `result.completed.kickoff` will resolve.
   *
   * ```js
   * //
   * const { on, process, after } = require('rx-helper')
   * on('kickoff', () => after(50, () => '#go'), { type: 'search' })
   * // Logs Done once 50 ms has elapsed
   * const result = process({ type: 'kickoff' })
   * result.completed.kickoff.then(() => console.log('done'))
   * ```
   * @see EventMatcher
   */
  on(eventMatcher: EventMatcher, subscriber: Subscriber, config: HandlerConfig = {}) {
    const removed = new Subject()
    const removeHandler = new Subscription(() => {
      this.allHandlers.delete(name)
      removed.next()
    })

    const name = this.uniquifyName(config.name, eventMatcher, "handler")
    const predicate = getEventPredicate(eventMatcher || (() => true))
    const concurrency = config.concurrency || config.mode || Concurrency.parallel
    const cutoffHandler = config.onCutoff

    let prevSub: Subscription // for cutoff to unsubscribe, mute not to start a new
    // let prevEnder:Subject    // for cutoff to call .error()
    let prevEnd: Promise<any> // for serial to chain on

    // Build a function, and keep it around for #process, which
    // returns a Promise for any handling done for this event
    const handlerPromiser = (event: Event, context?: any) => {
      // If this handler doesn't apply to this event...
      if (!predicate({ event })) {
        return Promise.resolve(undefined)
      }

      let recipe: Observable<any>
      let ender = new Subject()
      let completed = ender.toPromise()

      // Call this if we fail to get the recipe, or subscribe to it
      const reportFail = (ex: any) => {
        reportError(ex)
        removeHandler.unsubscribe()
        ender.error(ex)
      }

      // 1. Get the Observable aka recipe back from the handler
      try {
        const eventStreamItem = { event, context, type: event.type, payload: event.payload }
        const subscriberReturnValue = subscriber(eventStreamItem, event.payload)
        recipe = toObservable(subscriberReturnValue).pipe(takeUntil(removed))
      } catch (ex) {
        reportFail(ex)
        // will warn of unhandled rejection error if completed and completed.bad are not handled
        return completed
      }

      // 2. If processing results, set that up
      if (config.processResults || config.type || config.triggerAs) {
        const triggerType = config.type || config.triggerAs
        const opts: SubscribeConfig = triggerType ? { type: triggerType } : {}
        if (config.withContext) {
          opts.context = context
        }
        // Some events from an Observable may be seen prior to the next event
        this.subscribe(ender, opts)
      }

      // 3. Subscribe to the recipe accordingly
      switch (concurrency) {
        case Concurrency.serial:
          if (prevSub && !prevSub.closed) {
            if (!prevEnd) {
              prevEnd = completed
            } else {
              prevEnd.then(() => {
                prevSub = recipe.subscribe(ender)
              })
              prevEnd = prevEnd.then(() => completed)
            }
          } else {
            prevEnd = completed
            prevSub = recipe.subscribe(ender)
          }
          break
        case Concurrency.mute:
          if (prevSub && !prevSub.closed) {
            // dies in a fire - but do we notify ?
            // ender.error('mute')
          } else {
            prevSub = recipe.subscribe(ender)
          }
          break
        case Concurrency.cutoff:
          if (prevSub && !prevSub.closed) {
            prevSub.unsubscribe()
          }
          prevSub = recipe.subscribe(ender)
          if (cutoffHandler) {
            prevSub.add(() => {
              if (!ender.isStopped) cutoffHandler({ event })
            })
          }

          break
        case Concurrency.toggle:
          if (prevSub && !prevSub.closed) {
            prevSub.unsubscribe()
          } else {
            prevSub = recipe.subscribe(ender)
            if (cutoffHandler) {
              prevSub.add(() => {
                if (!ender.isStopped) cutoffHandler({ event })
              })
            }
          }
          break
        case Concurrency.parallel:
        default:
          recipe.subscribe(ender)
          break
      }

      return completed
    }

    this.allHandlers.set(name, handlerPromiser)
    return removeHandler
  }

  /**
   * Filters are synchronous functions that sequentially process events,
   * possibly changing them or creating synchronous state changes.
   * Filters are useful for type-checking, writing to a memory-based store.
   * Filters run in series. Their results are present on the return value of `process`/`trigger`
   * ```js
   * agent.filter('search/message/success', ({ event }) => console.log(event))
   * ```
   * Returns an object which, when unsubscribed, will remove our filter. Filters are *not* removed
   * automatically upon untrapped errors, like handlers attached via `on`.
   */
  filter(eventMatcher: EventMatcher, filter: Subscriber, config: HandlerConfig = {}) {
    validateSubscriberName(config.name)
    const removeFilter = new Subscription(() => {
      this.allFilters.delete(name)
    })

    // Pass all events unless otherwise told
    const predicate = eventMatcher ? getEventPredicate(eventMatcher) : () => true
    const _filter: Subscriber = (item: EventedItem) => {
      if (predicate(item)) {
        return filter(item, item.event.payload)
      }
    }

    const name = this.uniquifyName(config.name, eventMatcher, "filter")
    this.allFilters.set(name, _filter)

    // The subscription does little except give us an object
    // which, when unsubscribed, will remove our filter
    return removeFilter
  }

  spy(fn: Subscriber, config: HandlerConfig = {}) {
    config.name = config.name || "spy"
    let sub: Subscription
    let callFnUnsubOnError = (item: EventedItem, payload?: any): any => {
      try {
        return fn(item, payload)
      } catch (err) {
        reportError(err, `Spy ${config.name} threw an error "${err.message}" and has been removed`)
        if (sub) {
          sub.unsubscribe()
        }
      }
    }
    sub = this.filter(true, callFnUnsubOnError, config)
    return sub
  }

  /**
   * Subscribes to an Observable of events (Flux Standard Action), sending
   * each through `agent.process`. If the Observable is not of FSAs, include a
   * `type` or `triggerAs` field in the 2nd argument to wrap the Observable's
   * items in FSAs of that type.
   * Allows a shorthand where the second argument is just a string type for wrapping.
   * @return A subscription handle with which to unsubscribe()
   *
   */
  subscribe(item$: Observable<any>, config: SubscribeConfig | string = {}): Subscription {
    const _config = typeof config === "string" ? { type: config } : config
    const triggerType = _config.type || _config.triggerAs
    return item$.subscribe(item => {
      if (triggerType) {
        this.trigger(triggerType, item)
      } else {
        const event = _config.type ? { type: _config.type, payload: item } : item
        this.process(event, _config.context)
      }
    })
  }

  /**
   * Removes all filters and handlers, not canceling any in-progress consequences.
   * Useful as the first line of a script in a Hot-Module Reloading environment.
   */
  reset() {
    this.allFilters.clear()
    this.allHandlers.clear()
  }

  private runFilters(item: EventedItem, results: Map<string, any>): void {
    // Run all filters sync (RxJS as of v6 no longer will sync error)
    for (let filterName of this.allFilters.keys()) {
      let filter = this.allFilters.get(filterName)
      let result
      let err
      try {
        // @ts-ignore
        result = filter(item)
      } catch (ex) {
        err = ex
        throw ex
      } finally {
        results.set(filterName, result || err)
      }
    }
  }

  private uniquifyName(
    name: string | undefined,
    eventMatcher: EventMatcher | undefined,
    type: "handler" | "filter"
  ) {
    const nameBase =
      //@ts-ignore
      name || (eventMatcher && eventMatcher.substring ? eventMatcher.toString() : type)
    validateSubscriberName(nameBase)
    const _name =
      this[type + "Names"]().includes(nameBase) || nameBase === type
        ? `${nameBase}_${++this._subscriberCount}`
        : nameBase

    return _name
  }
}

//
//
/**
 * An agent that accepts a `StoreLike` and synchronously dispatches every event (with `filter`)
 * to its store. Its process method will throw if the store or reducer throws.
 */
export class StoreAgent extends Agent {
  private _store: StoreLike

  public get state(): any {
    return this._store.getState()
  }

  constructor(config: AgentConfig, store: StoreLike) {
    super(config)
    this._store = store

    this.filter(true, ({ event }) => this._store.dispatch(event))
  }
}
function getEventPredicate(eventMatcher: EventMatcher) {
  let predicate: (item: EventedItem) => boolean

  if (eventMatcher instanceof RegExp) {
    predicate = ({ event }: EventedItem) => eventMatcher.test(event.type)
  } else if (eventMatcher instanceof Function) {
    predicate = eventMatcher
  } else if (typeof eventMatcher === "boolean") {
    predicate = () => eventMatcher
  } else if (eventMatcher.constructor === Array) {
    predicate = ({ event }: EventedItem) => eventMatcher.includes(event.type)
  } else {
    predicate = ({ event }: EventedItem) => eventMatcher === event.type
  }
  return predicate
}

function validateSubscriberName(name: string | undefined) {
  assert(
    !name || !reservedSubscriberNames.includes(name),
    "The following subscriber names are reserved: " + reservedSubscriberNames.join(", ")
  )
}

export const reservedSubscriberNames = ["completed", "then", "catch"]

/**
 * A random enough identifier, 1 in a million or so,
 * to identify events in a stream. Not globally or cryptographically
 * random, just more random than: https://xkcd.com/221/
 */
export const randomId = (length: number = 7) => {
  return Math.floor(Math.pow(2, length * 4) * Math.random()).toString(16)
}

/**
 *  Returns an Observable of { delta } objects where delta is the time in ms
 *  since the GameLoop was constructed. Frames occur as often as
 *  requestAnimationFrame is invoked, so:
 *
 *  - Not while the browser is in the background
 *  - Whenever the browser has painted and is ready for you to update the view
 *
 * @example
 * ```js
 *  import { on, subscribe, GameLoop } from 'rx-helper'
 *  const frames = new GameLoop()
 *
 *  // Derive the worlds by incorporating each new delta given by the GameLoop
 *  const worlds = frames.pipe(
 *     map(({ delta }) => delta),
 *     scan(function aWholeNewWorld(oldWorld, delta) {
 *       return aWholeNewWorld
 *     }, {})
 *  )
 *
 *  // Handle a 'world' event by drawing it to the on-screen canvas
 *  on("world", ({ event: { payload: { world }}}) => {
 *    drawToCanvas(world)
 *  })
 *
 *  // Process the world stream, derived from the GameLoop, as events of type 'world'
 *  subscribe(worlds, { type: "world" })
 * ```
 */
export function GameLoop() {
  if (typeof animationFrameScheduler === "undefined") {
    throw new Error("ERR: animationFrame not detected in this environment.")
  }
  const startTime = animationFrameScheduler.now()
  return interval(0, animationFrameScheduler).pipe(
    map(() => ({
      delta: animationFrameScheduler.now() - startTime
    }))
  )
}
/**
 * A filter that adds a string of hex digits to
 * event.meta.eventId to uniquely identify an event among its neighbors.
 * @see randomId
 */
export const randomIdFilter = (length: number = 7, key = "eventId") => ({ event }: EventedItem) => {
  event.meta = event.meta || {}
  const newId = randomId(length)
  // @ts-ignore
  event.meta[key] = newId
}

function reportError(err: Error, msg = err.message) {
  if (msg.match(/NoPrintError/i)) {
    return
  }
  console.error(msg, err.stack)
}

/**
 * Pretty-print an event */
export const pp = (event: Event) => JSON.stringify(event)

/** An instance of Agent - also exported as `app`. */
export const agent = new Agent()
/** An instance of Agent - also exported as `agent`. */
export const app = agent
/** Calls the corresponding method of, `app`, the default agent */
export const { process, trigger, filter, spy, on, subscribe, reset } = {
  process: agent.process.bind(agent),
  trigger: agent.trigger.bind(agent),
  filter: agent.filter.bind(agent),
  spy: agent.spy.bind(agent),
  on: agent.on.bind(agent),
  subscribe: agent.subscribe.bind(agent),
  reset: agent.reset.bind(agent)
}

/**
 * Returns an Observable of the value, or result of the function call, after
 * the number of milliseconds given. After is lazy and cancelable! So nothing happens until .subscribe
 * is called explicitly (via subscribe) or implicitly (toPromise(), await).
 * For a delay of 0, the function is executed synchronously when .subscribe is called.
 * The optional 3rd argument can be a label which will be passed to the function.
 * @returns An Observable of the object or thunk return value. It is 'thenable', so may also be awaited directly.
 * @example after(100, label => ({type: `Timeout-${label}`}), 'session_expired').subscribe(event => ...)
 */
export const after = (ms: number, objOrFn: any, label?: any): AwaitableObservable => {
  const valueProducer = typeof objOrFn === "function" ? () => objOrFn(label) : () => objOrFn
  const delay = ms <= 0 ? of(0) : ms === Infinity ? never() : timer(ms)

  const resultObs = delay.pipe(map(valueProducer))

  // after is a 'thenable, thus usable with await.
  // ref: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/await
  // @ts-ignore
  resultObs.then = function(resolve, reject) {
    return this.toPromise().then(resolve, reject)
  }
  // @ts-ignore
  return resultObs
}

/** Controls what types can be returned from an `on` handler:
    Primitive types: `of()`
    Promises: `from()`
    Observables: pass-through
*/
function toObservable(_results: any) {
  if (typeof _results === "undefined") return of(undefined)

  // An Observable is preferred
  if (_results.subscribe) return _results

  // Returning a subscription from a handler will allow
  // modes serial and cutoff to work.
  // Remember we're already subscribed - just add
  // completion/teardown logic.
  if (_results.unsubscribe)
    return new Observable(notify => {
      const sub: Subscription = _results
      sub.add(() => notify.complete())
      return () => sub.unsubscribe()
    })

  // A Promise is acceptable
  if (_results.then) return from(_results)

  // otherwiser we convert it to a single-item Observable
  return of(_results)
}
