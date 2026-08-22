# universal-graceful-exit

A low-level lifecycle manager for Node.js. Automatically tracks network buffers and guarantees that data sent in fire-and-forget mode (to Redis, RabbitMQ, Postgres, etc.) is not lost when the application exits or on critical errors.

## Why do you need this?

You no longer need to call `redis.quit()` or `channel.close()` manually. The package watches system TCP sockets and prevents Node.js from exiting until the internal socket buffer (`writableLength`) becomes 0.
Always work with any type of servers, like WebSocketServer. The only difference is in using `trackServer(wss)` for this type of servers because under the hood WebSocketServer is instance of EventEmitter class.

```javascript
import { trackServer } from 'universal-graceful-exit';

const wss = new WebSocketServer({ port: config.port });
trackServer(wss)
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
