export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Campus Shuttle Telemetry API',
    version: '0.1.0',
    description:
      'Read API over the telemetry store. Writes arrive over MQTT, not HTTP — ' +
      'this surface is for dashboards, schedule tools and operations staff.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness and database reachability',
        responses: { 200: { description: 'Service healthy' }, 503: { description: 'Database unreachable' } },
      },
    },
    '/vehicles': {
      get: {
        summary: 'List vehicles with connection status',
        responses: { 200: { description: 'Vehicle list' } },
      },
    },
    '/vehicles/{id}/latest': {
      get: {
        summary: 'Most recent reading for one vehicle',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Latest reading' }, 404: { description: 'No readings' } },
      },
    },
    '/vehicles/{id}/track': {
      get: {
        summary: 'Historical track for one vehicle, ordered by device time',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 10000 } },
        ],
        responses: { 200: { description: 'Ordered readings' }, 400: { description: 'Bad time range' } },
      },
    },
    '/fleet/positions': {
      get: {
        summary: 'Latest position per vehicle — the live map feed',
        responses: { 200: { description: 'One row per vehicle' } },
      },
    },
    '/metrics/ingest': {
      get: {
        summary: 'Readings written per minute over the last hour',
        responses: { 200: { description: 'Time bucketed counts' } },
      },
    },
        '/alerts': {
      get: {
        summary: 'Alert episodes, newest first',
        parameters: [
          { name: 'open', in: 'query', schema: { type: 'boolean' }, description: 'Only episodes that have not closed' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 } },
        ],
        responses: { 200: { description: 'Alert episodes' } },
      },
    },
    '/vehicles/{id}/alerts': {
      get: {
        summary: 'Alert history for one vehicle',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 } },
        ],
        responses: { 200: { description: 'Alert episodes for the vehicle' } },
      },
    },
  },
};
