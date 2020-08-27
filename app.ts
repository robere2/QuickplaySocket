import * as WebSocket from 'ws'
import {getRedis} from './redis'
import * as IORedis from 'ioredis'
import {
    ActionBus,
    AlterAliasedActionAction,
    AlterButtonAction,
    AlterScreenAction,
    AlterTranslationAction,
    AuthGoogleEndHandshakeAction,
    AuthMojangEndHandshakeAction,
    AuthReestablishAuthedConnectionAction,
    DeleteAliasedActionAction,
    DeleteButtonAction,
    DeleteScreenAction,
    DeleteTranslationAction,
    InitializeClientAction,
    MigrateKeybindsAction,
    Resolver
} from '@quickplaymod/quickplay-actions-js'
import StateAggregator from './StateAggregator'
import SessionContext from './SessionContext'
import MigrateKeybindsSubscriber from './subscribers/MigrateKeybindsSubscriber'
import InitializeClientSubscriber from './subscribers/InitializeClientSubscriber'
import AuthEndHandshakeSubscriber from './subscribers/AuthEndHandshakeSubscriber'
import AuthReestablishAuthedConnectionSubscriber from './subscribers/AuthReestablishAuthedConnectionSubscriber'
import AlterScreenSubscriber from './subscribers/AlterScreenSubscriber'
import DeleteScreenSubscriber from './subscribers/DeleteScreenSubscriber'
import AlterButtonSubscriber from './subscribers/AlterButtonSubscriber'
import DeleteButtonSubscriber from './subscribers/DeleteButtonSubscriber'
import DeleteAliasedActionSubscriber from './subscribers/DeleteAliasedActionSubscriber'
import AlterAliasedActionSubscriber from './subscribers/AlterAliasedActionSubscriber'
import AlterTranslationSubscriber from './subscribers/AlterTranslationSubscriber'
import DeleteTranslationSubscriber from './subscribers/DeleteTranslationSubscriber'

let redis : IORedis.Redis
let actionBus : ActionBus

(async () => {
    redis = await getRedis()
    await begin()
})()

/**
 * Begin the websocket server.
 */
async function begin() {
    // Create new action bus and add all subscriptions
    actionBus = new ActionBus()
    actionBus.subscribe(MigrateKeybindsAction, new MigrateKeybindsSubscriber())
    const endAuthSub = new AuthEndHandshakeSubscriber()
    actionBus.subscribe(AuthMojangEndHandshakeAction, endAuthSub)
    actionBus.subscribe(AuthGoogleEndHandshakeAction, endAuthSub)
    actionBus.subscribe(InitializeClientAction, new InitializeClientSubscriber())
    actionBus.subscribe(AuthReestablishAuthedConnectionAction, new AuthReestablishAuthedConnectionSubscriber())
    actionBus.subscribe(AlterScreenAction, new AlterScreenSubscriber())
    actionBus.subscribe(DeleteScreenAction, new DeleteScreenSubscriber())
    actionBus.subscribe(AlterButtonAction, new AlterButtonSubscriber())
    actionBus.subscribe(DeleteButtonAction, new DeleteButtonSubscriber())
    actionBus.subscribe(AlterAliasedActionAction, new AlterAliasedActionSubscriber())
    actionBus.subscribe(DeleteAliasedActionAction, new DeleteAliasedActionSubscriber())
    actionBus.subscribe(AlterTranslationAction, new AlterTranslationSubscriber())
    actionBus.subscribe(DeleteTranslationAction, new DeleteTranslationSubscriber())

    // Populate redis
    console.log('Beginning population.')
    await StateAggregator.populate()
    console.log('Population complete. Initializing on port 80.')

    // Create websocket server
    const wss = new WebSocket.Server({ port: 80 })
    wss.on('connection', async function connection(conn) {

        const ctx = new SessionContext(conn)
        ctx.lastPong = new Date().getTime();

        // Adding a reference to the connection ctx is the best way to do this.
        (conn as unknown as {ctx: SessionContext}).ctx = ctx

        conn.on('pong', () => {
            ctx.lastPong = new Date().getTime()
        })

        conn.on('message', function incoming(message) {
            if(!(message instanceof Buffer)) {
                return
            }
            const action = Resolver.from(message)
            actionBus.publish(action, ctx)
        })

        conn.on('close', async () => {
            const connCount = await redis.decr('connections')
            await redis.publish('conn-notif', connCount.toString())
            if(ctx.authedResetTimeout != null) {
                clearTimeout(ctx.authedResetTimeout)
                ctx.authedResetTimeout = null
            }
        })

        conn.on('error', async function (err) {
            console.warn(err)
            conn.terminate()
        })

        const connCount = await redis.incr('connections')
        await redis.publish('conn-notif', connCount.toString())
    })

    // Ping clients every 30 seconds; Terminate clients which haven't responded in 60 seconds
    const pingInterval = 30000
    setInterval(() => {
        const now = new Date().getTime()
        wss.clients.forEach((conn) => {
            if((conn as unknown as {ctx: SessionContext}).ctx.lastPong < now - pingInterval * 2) {
                conn.terminate()
                return
            }
            conn.ping()
        })
    }, pingInterval)

    wss.on('error', async function (err) {
        console.warn(err)
    })
}
