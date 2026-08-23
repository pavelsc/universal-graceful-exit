[![CI](https://github.com/pavelsc/universal-graceful-exit/actions/workflows/test.yml/badge.svg)](https://github.com/pavelsc/universal-graceful-exit/actions/workflows/test.yml)
[![Socket Badge](https://badge.socket.dev/npm/package/universal-graceful-exit)](https://socket.dev/npm/package/universal-graceful-exit)

# universal-graceful-exit

A low-level lifecycle manager for Node.js. Automatically tracks network buffers and guarantees that data sent in fire-and-forget mode (to Redis, RabbitMQ, Postgres, etc.) is not lost when the application exits or on critical errors.

## Why do you need this?

You no longer need to call `redis.quit()` or `channel.close()` manually. The package watches system TCP sockets and prevents Node.js from exiting until the internal socket buffer (`writableLength`) becomes 0.
It works with any type of server natively, and with servers like WebSocketServer register those with `trackServer` because under the hood they are EventEmitter instances, not native HTTP servers:

```javascript
import { trackServer } from 'universal-graceful-exit';

const wss = new WebSocketServer({ port: config.port });
trackServer(wss);
```

Register outbound clients (ioredis, amqplib, pg, ...) with `trackClient` so they get `quit` / `close` / `end` / `disconnect` on shutdown:

```javascript
import { trackClient } from 'universal-graceful-exit';

trackClient(redis);
trackClient(amqpConnection);
```

## Installation

```bash
npm install universal-graceful-exit
```

## Usage

Import the package as **the very first line** of your application:

```javascript
import 'universal-graceful-exit'; // It intercepts signals and unhandledRejections on its own
import { isStopped } from 'universal-graceful-exit';
import { myRabbitClient } from './db';

async function worker() {
  while (!isStopped()) {
    // Your business logic
    myRabbitClient.sendToQueue('tasks', Buffer.from('data')); // no await!
  }
}
```

```javascript
import { isStopped, startTask, endTask } from 'universal-graceful-exit';

async function startConsuming(rabbitConn) {
  const rabbitChannel = await rabbitConn.createChannel();

  await rabbitChannel.prefetch(200);

  const { consumerTag } = await rabbitChannel.consume(
    'ordered_events',
    async msg => {
      if (!msg) return;
      startTask();
      const result = await processEvent(msg.content);
      if (msg.properties.replyTo) {
        rabbitChannel.sendToQueue(msg.properties.replyTo, Buffer.from(response), {
          correlationId: msg.properties.correlationId
        });
      }
      rabbitChannel.ack(msg);
      endTask();
      if (isStopped()) {
        await rabbitChannel.cancel(consumerTag).catch(() => {});
      }
    },
    { noAck: false }
  );
}
```

## Programmatic Trigger

If you need to trigger a graceful shutdown from inside your application logic (e.g., an admin route or a critical business workflow), you can emit a custom event on the global `process` object. This allows you to pass a custom exit code without forcing a hard crash:

```javascript
import 'universal-graceful-exit';

// Trigger a safe, buffered exit with a custom exit code (e.g., 5)
process.emit('gracefulExit', 5);
```

## Proof of Concept

Log example of usage with `ws` and `ioredis` libraries

```log
[UniversalExit] Received OS signal: SIGINT
[UniversalExit] Clean shutdown initiated. Native Servers: 0, Custom Servers: 1, Sockets: 4
[UniversalExit] currentTasks: 0, currentBytes: 0, customServers: 1, clients: 4
[UniversalExit] Closing client via quit...
[UniversalExit] Closing client via quit...
[UniversalExit] Closing client via quit...
[UniversalExit] Closing client via quit...
[UniversalExit] Scheduling next check #0. Sockets left: 4
[UniversalExit] Custom server close event
[WARN] EventServer - Websocket Server closed
[DEBUG] EventServer - Websocket Client Connection Close.
[UniversalExit] Socket natively CLOSED. Left in set: 3
[UniversalExit] Socket natively CLOSED. Left in set: 2
[UniversalExit] Socket natively CLOSED. Left in set: 1
[UniversalExit] Socket natively CLOSED. Left in set: 0
[UniversalExit] currentTasks: 0, currentBytes: 0, customServers: 0, clients: 0
[UniversalExit] All buffers, tasks, servers and clients cleared successfully. Exiting cleanly.
[DEBUG] App - Shut down complete!
```
