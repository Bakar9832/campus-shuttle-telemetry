import fs from "node:fs";
import path from "node:path";
import mqtt from "mqtt";
import { buildRoute } from "./route.js";
import { createVehicle } from "./vehicle.js";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const FLEET_SIZE = Number(process.env.FLEET_SIZE ?? 1);
const TICK_MS = Number(process.env.TICK_MS ?? 1000);
const ROUTE_FILE =
  process.env.ROUTE_FILE ?? path.resolve("routes/campus-loop.json");
const MAX_BUFFER = Number(process.env.MAX_BUFFER ?? 3600);
const DROPOUT_CHANCE  = Number(process.env.DROPOUT_CHANCE ?? 0.001);
const DROPOUT_MIN_SEC = Number(process.env.DROPOUT_MIN_SEC ?? 30);
const DROPOUT_MAX_SEC = Number(process.env.DROPOUT_MAX_SEC ?? 180);

const routeDef = JSON.parse(fs.readFileSync(ROUTE_FILE, "utf8"));
const route = buildRoute(routeDef.stops);

const vehicles = Array.from({ length: FLEET_SIZE }, (_, i) =>
  createVehicle({
    id: `shuttle-${String(i + 1).padStart(2, "0")}`,
    route,
    // spread vehicles evenly round the loop so they do not convoy
    startOffset: (route.length / FLEET_SIZE) * i,
  }),
);

const statusTopic = (id) => `fleet/${id}/status`;
const telemetryTopic = (id) => `fleet/${id}/telemetry`;

console.log(
  `[sim] route "${routeDef.name}" ${(route.length / 1000).toFixed(2)} km, ` +
    `${route.stops.length} stops, ${FLEET_SIZE} vehicle(s), tick ${TICK_MS}ms`,
);

// One connection per vehicle: each unit is its own device, and a per-device
// last-will is what makes offline detection work without a heartbeat table.
const clients = vehicles.map((veh) => {
  const client = mqtt.connect(MQTT_URL, {
    clientId: `sim-${veh.id}-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 2000,
    will: {
      topic: statusTopic(veh.id),
      payload: JSON.stringify({ vehicleId: veh.id, online: false }),
      qos: 1,
      retain: true,
    },
  });

  const pending = [];
  let droppedFromBuffer = 0;
  let offlineUntil = 0;

  function buffer(reading) {
    if (pending.length >= MAX_BUFFER) {
      pending.shift();
      droppedFromBuffer++;
      if (droppedFromBuffer % 100 === 1) {
        console.warn(
          `[sim] ${veh.id} buffer full - dropped ${droppedFromBuffer} oldest`,
        );
      }
    }
    pending.push(reading);
  }

  function maybeDropout() {
    const now = Date.now();

    if (offlineUntil > 0) {
      if (now >= offlineUntil) {
        offlineUntil = 0;
        console.log(`[sim] ${veh.id} coverage restored, reconnecting`);
        client.reconnect();
      }
      return false;
    }

    if (Math.random() < DROPOUT_CHANCE) {
      const seconds =
        DROPOUT_MIN_SEC + Math.random() * (DROPOUT_MAX_SEC - DROPOUT_MIN_SEC);
      offlineUntil = now + seconds * 1000;
      console.log(`[sim] ${veh.id} lost coverage for ${Math.round(seconds)}s`);
      // force=true: drop the socket without a DISCONNECT packet, so the broker
      // treats it as a dead client and publishes the will.
      client.end(true);
      return false;
    }
    return true;
  }

  function replay() {
    if (pending.length === 0) return;
    console.log(
      `[sim] ${veh.id} replaying ${pending.length} buffered readings`,
    );
    const backlog = pending.splice(0, pending.length);
    for (const reading of backlog) {
      client.publish(telemetryTopic(veh.id), JSON.stringify(reading), {
        qos: 1,
      });
    }
  }

  client.on("connect", () => {
    console.log(`[sim] ${veh.id} connected`);
    client.publish(
      statusTopic(veh.id),
      JSON.stringify({
        vehicleId: veh.id,
        online: true,
        ts: new Date().toISOString(),
      }),
      { qos: 1, retain: true },
    );
    replay();
  });

  client.on("error", (err) =>
    console.error(`[sim] ${veh.id} mqtt error: ${err.message}`),
  );
  return { veh, client, buffer, maybeDropout };
});

const dt = TICK_MS / 1000;
const timer = setInterval(() => {
  for (const { veh, client, buffer, maybeDropout  } of clients) {
    const online = maybeDropout();
    const reading = veh.tick(dt);
    if (!online || !client.connected) { buffer(reading); continue; }
    client.publish(telemetryTopic(veh.id), JSON.stringify(reading), { qos: 1 });
  }
}, TICK_MS);

function shutdown() {
  clearInterval(timer);
  let pending = clients.length;
  if (pending === 0) process.exit(0);
  for (const { veh, client } of clients) {
    client.publish(
      statusTopic(veh.id),
      JSON.stringify({
        vehicleId: veh.id,
        online: false,
        ts: new Date().toISOString(),
      }),
      { qos: 1, retain: true },
      () =>
        client.end(false, () => {
          if (--pending === 0) process.exit(0);
        }),
    );
  }
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
