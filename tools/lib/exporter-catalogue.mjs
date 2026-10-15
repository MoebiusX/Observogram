// ============================================================
// exporter-catalogue.mjs — the built-in exporter family catalogue.
//
// DATA, not engine code: the crawler (tools/lib/crawler.mjs, through
// tools/lib/exporter-metrics.mjs) reads a prebuilt exporter's config file
// against these entries and emits the metric families the config switches
// on, as candidates (`originKind: 'exporter-config'`, `confidence:
// 'inferred'`). A downstream carries a larger catalogue as a JSON file of
// the same shape (`packc x-ray --exporter-catalogue <file>`, or
// `crawlFiles(files, { exporterCatalogue })`): its entries replace a
// built-in entry with the same `id` and add the rest, so the engine is
// never diffed. docs/DOWNSTREAM.md §18 has the format.
//
// An entry:
//   id         the exporter's name in crawler.discovered.exporters
//   match.keys top-level mapping keys a config file must all carry
//   namespace  { path, default } — the metric name prefix the config sets
//   gates      { <gate>: { path, default } } — boolean switches; a family
//              with `gate` is emitted only when that switch is on
//   scopes     { <scope>: { path } } — object selections; a family with
//              `scope` is emitted only when that selection is non-empty
//   families   [{ name, type, help, labels, gate?, scope? }] — `name` is
//              joined to the namespace with `_`
//
// The IBM entry is a small subset of what mq-metric-samples' Prometheus
// collector exposes, enough to name the queue manager, queue and channel
// families a config enables. The names are inferred, not observed: publish
// the exporter's real list with `packc emit --exporter <url>` and the
// manifest outranks every name here.
// ============================================================

export const EXPORTER_CATALOGUE = {
  version: 1,
  exporters: [
    {
      id: 'ibm-mq',
      title: 'IBM MQ — mq-metric-samples (Prometheus collector)',
      source: 'https://github.com/ibm-messaging/mq-metric-samples',
      match: { keys: ['global', 'connection', 'objects', 'prometheus'] },
      namespace: { path: 'prometheus.namespace', default: 'ibmmq' },
      gates: {
        objectStatus: { path: 'global.useObjectStatus', default: true },
        publications: { path: 'global.usePublications', default: true },
      },
      scopes: {
        queues: { path: 'objects.queues' },
        channels: { path: 'objects.channels' },
      },
      families: [
        { name: 'qmgr_status', type: 'gauge', help: 'Queue manager status', labels: ['qmgr', 'platform'], gate: 'objectStatus' },
        { name: 'qmgr_uptime', type: 'gauge', help: 'Queue manager uptime in seconds', labels: ['qmgr', 'platform'], gate: 'objectStatus' },
        { name: 'qmgr_connection_count', type: 'gauge', help: 'Connections to the queue manager', labels: ['qmgr', 'platform'], gate: 'objectStatus' },
        { name: 'qmgr_channel_initiator_status', type: 'gauge', help: 'Channel initiator status', labels: ['qmgr', 'platform'], gate: 'objectStatus' },
        { name: 'qmgr_command_server_status', type: 'gauge', help: 'Command server status', labels: ['qmgr', 'platform'], gate: 'objectStatus' },
        { name: 'qmgr_user_cpu_time_percentage', type: 'gauge', help: 'User CPU time of the queue manager', labels: ['qmgr', 'platform'], gate: 'publications' },
        { name: 'qmgr_system_cpu_time_percentage', type: 'gauge', help: 'System CPU time of the queue manager', labels: ['qmgr', 'platform'], gate: 'publications' },
        { name: 'qmgr_log_in_use_bytes', type: 'gauge', help: 'Recovery log in use', labels: ['qmgr', 'platform'], gate: 'publications' },
        { name: 'qmgr_log_write_latency_seconds', type: 'gauge', help: 'Recovery log write latency', labels: ['qmgr', 'platform'], gate: 'publications' },
        { name: 'qmgr_mqconn_mqconnx_count', type: 'counter', help: 'MQCONN and MQCONNX calls', labels: ['qmgr', 'platform'], gate: 'publications' },
        { name: 'queue_depth', type: 'gauge', help: 'Messages on the queue', labels: ['qmgr', 'queue'], gate: 'publications', scope: 'queues' },
        { name: 'queue_mqput_mqput1_count', type: 'counter', help: 'MQPUT and MQPUT1 calls on the queue', labels: ['qmgr', 'queue'], gate: 'publications', scope: 'queues' },
        { name: 'queue_mqget_count', type: 'counter', help: 'MQGET calls on the queue', labels: ['qmgr', 'queue'], gate: 'publications', scope: 'queues' },
        { name: 'queue_oldest_message_age', type: 'gauge', help: 'Age of the oldest message on the queue in seconds', labels: ['qmgr', 'queue'], gate: 'objectStatus', scope: 'queues' },
        { name: 'queue_uncommitted_messages', type: 'gauge', help: 'Uncommitted messages on the queue', labels: ['qmgr', 'queue'], gate: 'objectStatus', scope: 'queues' },
        { name: 'queue_time_since_put', type: 'gauge', help: 'Seconds since the last put', labels: ['qmgr', 'queue'], gate: 'objectStatus', scope: 'queues' },
        { name: 'queue_time_since_get', type: 'gauge', help: 'Seconds since the last get', labels: ['qmgr', 'queue'], gate: 'objectStatus', scope: 'queues' },
        { name: 'channel_status', type: 'gauge', help: 'Channel status', labels: ['qmgr', 'channel', 'type', 'connname', 'jobname', 'rqmname'], gate: 'objectStatus', scope: 'channels' },
        { name: 'channel_messages', type: 'counter', help: 'Messages sent over the channel', labels: ['qmgr', 'channel', 'type', 'connname', 'jobname', 'rqmname'], gate: 'objectStatus', scope: 'channels' },
        { name: 'channel_bytes_sent', type: 'counter', help: 'Bytes sent over the channel', labels: ['qmgr', 'channel', 'type', 'connname', 'jobname', 'rqmname'], gate: 'objectStatus', scope: 'channels' },
        { name: 'channel_bytes_rcvd', type: 'counter', help: 'Bytes received over the channel', labels: ['qmgr', 'channel', 'type', 'connname', 'jobname', 'rqmname'], gate: 'objectStatus', scope: 'channels' },
      ],
    },
  ],
};
