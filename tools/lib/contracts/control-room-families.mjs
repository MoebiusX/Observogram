// tools/lib/contracts/control-room-families.mjs
//
// THE CONTROL ROOM'S KNOWN METRIC FAMILIES — what a service's live side
// exposes that people recognise (HTTP traffic, the runtime, containers,
// Kubernetes, nodes, a broker, a database, a cache, a gateway), each as a
// few numbers and one small chart. Read through the live endpoint's PromQL
// query capability (`control_room_query`, tools/lib/contracts/mcp-capabilities.mjs)
// by tools/lib/control-room.mjs, for Overview's control room.
//
// THESIS LINE: a tile is SAMPLED, point-in-time evidence about what runs.
// It never feeds the grade, a Verified stamp or the board's letter. A
// tile's tone comes from a bound whose source it names — a library entry
// (`library:<entry>#<sli or param>`, held equal to the YAML by
// tools/test-control-room.mjs) or `stated` (a default this file states,
// shown as such) — and a tile with no bound is `info`.
//
// A row:
//   id        stable family id (a downstream row with the same id replaces it)
//   title     the words people know ("HTTP traffic")
//   layer     the board's layer it belongs to: app · platform · infra
//   variants  the first variant whose `requires` metric names are ALL in the
//             live answer is the one read (the OTel semantic-convention
//             spelling or a client library's); a family with no such
//             variant is named once as not exposed, never drawn as zeros
//     tiles   [{ id, label, unit, expr, judge, empty? }] — expr is an instant
//             query that answers ONE series; a count uses the presence-guarded
//             zero (`or (<base> * 0)`) so "nothing happened" reads 0 only
//             when the series it counts exists; `empty` says why a query that
//             answers nothing does ("Not exposed per queue")
//     chart   { label, unit, expr } | null — the same kind of expression,
//             read as a subquery over the chart's range
//   judge     { kind: 'ceiling' | 'floor' | 'info', bound, critical, from }
//             ceiling: warn above `bound`, bad above `critical`;
//             floor:   warn below `bound`, bad below `critical`
//
// Units: per-second · ratio · seconds · bytes · count · cores
//
// A downstream adds its own families from a JSON file the server loads
// (OBSERVOGRAM_CONTROL_ROOM_FAMILIES; tools/lib/control-room.mjs
// controlRoomFamilies validates and merges it by id). Nothing in this file
// names a downstream's product.
//
// Pure data. No imports.

export const CONTROL_ROOM_UNITS = Object.freeze(['per-second', 'ratio', 'seconds', 'bytes', 'count', 'cores']);
export const CONTROL_ROOM_LAYERS = Object.freeze(['app', 'platform', 'infra']);

const t = (id, label, unit, expr, judge = { kind: 'info' }, empty = undefined) => Object.freeze({ id, label, unit, expr, judge: Object.freeze(judge), ...(empty ? { empty } : {}) });
const chart = (label, unit, expr) => Object.freeze({ label, unit, expr });
const v = (requires, tiles, ch = null) => Object.freeze({ requires: Object.freeze(requires), tiles: Object.freeze(tiles), chart: ch });

export const CONTROL_ROOM_FAMILIES = Object.freeze([
  Object.freeze({
    id: 'http', title: 'HTTP traffic', layer: 'app',
    variants: Object.freeze([
      // OTel semantic conventions, seconds in the name.
      v(['http_server_request_duration_seconds_count', 'http_server_request_duration_seconds_bucket'], [
        t('rate', 'Requests', 'per-second', 'sum(rate(http_server_request_duration_seconds_count[5m]))'),
        t('errors', 'Server errors', 'ratio',
          '(sum(rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m])) or (sum(rate(http_server_request_duration_seconds_count{http_response_status_code!=""}[5m])) * 0)) / sum(rate(http_server_request_duration_seconds_count{http_response_status_code!=""}[5m]))',
          { kind: 'ceiling', bound: 0.005, critical: 0.05, from: 'stated' }),
        t('p99', 'Slowest 1 in 100', 'seconds', 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))',
          { kind: 'ceiling', bound: 0.5, critical: 1, from: 'library:http-service#latency_p99' }),
      ], chart('Requests', 'per-second', 'sum(rate(http_server_request_duration_seconds_count[5m]))')),
      // The same, without the unit suffix (some SDK exporters).
      v(['http_server_request_duration_count', 'http_server_request_duration_bucket'], [
        t('rate', 'Requests', 'per-second', 'sum(rate(http_server_request_duration_count[5m]))'),
        t('errors', 'Server errors', 'ratio',
          '(sum(rate(http_server_request_duration_count{http_response_status_code=~"5.."}[5m])) or (sum(rate(http_server_request_duration_count{http_response_status_code!=""}[5m])) * 0)) / sum(rate(http_server_request_duration_count{http_response_status_code!=""}[5m]))',
          { kind: 'ceiling', bound: 0.005, critical: 0.05, from: 'stated' }),
        t('p99', 'Slowest 1 in 100', 'seconds', 'histogram_quantile(0.99, sum by (le) (rate(http_server_request_duration_bucket[5m])))',
          { kind: 'ceiling', bound: 0.5, critical: 1, from: 'library:http-service#latency_p99' }),
      ], chart('Requests', 'per-second', 'sum(rate(http_server_request_duration_count[5m]))')),
      // A Prometheus client library's counter and histogram.
      v(['http_requests_total', 'http_request_duration_seconds_bucket'], [
        t('rate', 'Requests', 'per-second', 'sum(rate(http_requests_total[5m]))'),
        t('errors', 'Server errors', 'ratio',
          '(sum(rate(http_requests_total{status_code=~"5.."}[5m])) or (sum(rate(http_requests_total{status_code!=""}[5m])) * 0)) / sum(rate(http_requests_total{status_code!=""}[5m]))',
          { kind: 'ceiling', bound: 0.005, critical: 0.05, from: 'stated' }),
        t('p99', 'Slowest 1 in 100', 'seconds', 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))',
          { kind: 'ceiling', bound: 0.5, critical: 1, from: 'library:http-service#latency_p99' }),
      ], chart('Requests', 'per-second', 'sum(rate(http_requests_total[5m]))')),
    ]),
  }),
  Object.freeze({
    id: 'runtime', title: 'Processes', layer: 'app',
    variants: Object.freeze([
      v(['process_cpu_seconds_total', 'process_resident_memory_bytes'], [
        t('cpu', 'CPU in use', 'cores', 'sum(rate(process_cpu_seconds_total[5m]))'),
        t('memory', 'Memory held', 'bytes', 'sum(process_resident_memory_bytes)'),
        t('fds', 'Busiest file-handle use', 'ratio', 'max(process_open_fds / process_max_fds)',
          { kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'stated' }),
      ], chart('Memory held', 'bytes', 'sum(process_resident_memory_bytes)')),
    ]),
  }),
  Object.freeze({
    id: 'containers', title: 'Containers', layer: 'infra',
    variants: Object.freeze([
      v(['container_cpu_usage_seconds_total', 'container_memory_working_set_bytes'], [
        t('cpu', 'CPU in use', 'cores', 'sum(rate(container_cpu_usage_seconds_total{container!=""}[5m]))'),
        t('memory', 'Memory in use', 'bytes', 'sum(container_memory_working_set_bytes{container!=""})'),
        t('limit', 'Closest to its memory limit', 'ratio',
          'max(sum by (namespace, pod, container) (container_memory_working_set_bytes{container!=""}) / sum by (namespace, pod, container) (container_spec_memory_limit_bytes{container!=""} > 0))',
          { kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'stated' }),
        t('oom', 'Out of memory, last 15 minutes', 'count',
          'sum(increase(container_oom_events_total[15m])) or (count(container_oom_events_total) * 0)',
          { kind: 'ceiling', bound: 0.5, critical: 0.5, from: 'library:k8s-workload#oom_kills' }),
      ], chart('CPU in use', 'cores', 'sum(rate(container_cpu_usage_seconds_total{container!=""}[5m]))')),
    ]),
  }),
  Object.freeze({
    id: 'kubernetes', title: 'Kubernetes', layer: 'infra',
    variants: Object.freeze([
      // Running pods only: a finished Job's pod is never ready, and is not a fault.
      v(['kube_pod_status_ready', 'kube_pod_status_phase', 'kube_pod_container_status_restarts_total'], [
        t('ready', 'Pods ready', 'ratio',
          'sum(kube_pod_status_ready{condition="true"} and on (namespace, pod) (kube_pod_status_phase{phase="Running"} == 1)) / count(kube_pod_status_phase{phase="Running"} == 1)',
          { kind: 'floor', bound: 1, critical: 0.9, from: 'stated' }),
        t('restarts', 'Most restarts, last 15 minutes', 'count',
          'max(increase(kube_pod_container_status_restarts_total[15m])) or (count(kube_pod_container_status_restarts_total) * 0)',
          { kind: 'ceiling', bound: 3, critical: 6, from: 'library:k8s-workload#restart_rate' }),
      ], chart('Pods ready', 'count', 'sum(kube_pod_status_ready{condition="true"} and on (namespace, pod) (kube_pod_status_phase{phase="Running"} == 1))')),
    ]),
  }),
  Object.freeze({
    id: 'nodes', title: 'Nodes', layer: 'infra',
    variants: Object.freeze([
      v(['node_cpu_seconds_total', 'node_memory_MemAvailable_bytes', 'node_memory_MemTotal_bytes'], [
        t('cpu', 'Busiest node CPU', 'ratio', 'max(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))',
          { kind: 'ceiling', bound: 0.9, critical: 0.97, from: 'library:node#cpu_saturation' }),
        t('memory', 'Fullest node memory', 'ratio', 'max(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
          { kind: 'ceiling', bound: 0.9, critical: 0.97, from: 'library:node#memory_saturation' }),
        t('disk', 'Fullest root disk', 'ratio',
          'max(1 - node_filesystem_avail_bytes{mountpoint="/",fstype!="tmpfs"} / node_filesystem_size_bytes{mountpoint="/",fstype!="tmpfs"})',
          { kind: 'ceiling', bound: 0.85, critical: 0.95, from: 'library:node#filesystem_saturation' }),
      ], chart('Busiest node CPU', 'ratio', 'max(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))')),
    ]),
  }),
  Object.freeze({
    id: 'rabbitmq', title: 'RabbitMQ', layer: 'platform',
    variants: Object.freeze([
      // Per queue only where the broker labels its series by queue: its default
      // exposition sums every queue into one series a node, read as the total.
      v(['rabbitmq_queue_messages_ready', 'rabbitmq_queue_consumers'], [
        t('ready', 'Ready messages, all queues', 'count', 'sum(rabbitmq_queue_messages_ready)'),
        t('backlog', 'Longest queue (ready messages)', 'count',
          'max(rabbitmq_queue_messages_ready{queue!=""}) or (count(rabbitmq_queue_messages_ready{queue!=""}) * 0)',
          { kind: 'ceiling', bound: 100, critical: 500, from: 'library:rabbitmq#backlog_warning' }, 'Not exposed per queue'),
        t('idle', 'Queues with no consumer', 'count',
          'count(rabbitmq_queue_consumers{queue!=""} == 0) or (count(rabbitmq_queue_consumers{queue!=""}) * 0)',
          { kind: 'ceiling', bound: 0.5, critical: 0.5, from: 'stated' }, 'Not exposed per queue'),
        t('memory', 'Memory against its alarm', 'ratio',
          'max(rabbitmq_process_resident_memory_bytes / rabbitmq_resident_memory_limit_bytes)',
          { kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'library:rabbitmq#memory_saturation' }),
      ], chart('Ready messages', 'count', 'sum(rabbitmq_queue_messages_ready)')),
    ]),
  }),
  Object.freeze({
    id: 'postgresql', title: 'PostgreSQL', layer: 'platform',
    variants: Object.freeze([
      v(['pg_up', 'pg_stat_activity_count', 'pg_settings_max_connections'], [
        t('up', 'Databases answering', 'ratio', 'sum(pg_up) / count(pg_up)',
          { kind: 'floor', bound: 1, critical: 0.5, from: 'stated' }),
        t('connections', 'Fullest server\'s connections in use', 'ratio',
          'max(sum by (job, instance, server) (pg_stat_activity_count) / on (job, instance, server) max by (job, instance, server) (pg_settings_max_connections))',
          { kind: 'ceiling', bound: 0.8, critical: 0.95, from: 'library:postgresql#pool_warning' }),
        t('deadlocks', 'Deadlocks', 'per-second',
          'sum(rate(pg_stat_database_deadlocks[5m])) or (count(pg_stat_database_deadlocks) * 0)',
          { kind: 'ceiling', bound: 0.01, critical: 0.1, from: 'library:postgresql#deadlocks' }),
      ], chart('Connections', 'count', 'sum(pg_stat_activity_count)')),
    ]),
  }),
  Object.freeze({
    id: 'redis', title: 'Redis', layer: 'platform',
    variants: Object.freeze([
      v(['redis_up', 'redis_memory_used_bytes'], [
        t('up', 'Instances answering', 'ratio', 'sum(redis_up) / count(redis_up)',
          { kind: 'floor', bound: 1, critical: 0.5, from: 'stated' }),
        t('memory', 'Memory against its limit', 'ratio', 'max(redis_memory_used_bytes / (redis_memory_max_bytes > 0))',
          { kind: 'ceiling', bound: 0.85, critical: 0.95, from: 'library:redis#memory_saturation' }),
        t('evictions', 'Keys evicted', 'per-second',
          'sum(rate(redis_evicted_keys_total[5m])) or (count(redis_evicted_keys_total) * 0)',
          { kind: 'ceiling', bound: 1, critical: 10, from: 'library:redis#eviction_rate' }),
      ], chart('Commands', 'per-second', 'sum(rate(redis_commands_processed_total[5m]))')),
    ]),
  }),
  Object.freeze({
    id: 'kong', title: 'Kong gateway', layer: 'platform',
    variants: Object.freeze([
      v(['kong_http_requests_total', 'kong_datastore_reachable'], [
        t('rate', 'Requests through it', 'per-second', 'sum(rate(kong_http_requests_total[5m]))'),
        t('errors', 'Server errors', 'ratio',
          '(sum(rate(kong_http_requests_total{code=~"5.."}[5m])) or (sum(rate(kong_http_requests_total{code!=""}[5m])) * 0)) / sum(rate(kong_http_requests_total{code!=""}[5m]))',
          { kind: 'ceiling', bound: 0.005, critical: 0.05, from: 'stated' }),
        t('datastore', 'Datastore reachable', 'ratio', 'min(kong_datastore_reachable)',
          { kind: 'floor', bound: 1, critical: 0.5, from: 'stated' }),
      ], chart('Requests through it', 'per-second', 'sum(rate(kong_http_requests_total[5m]))')),
    ]),
  }),
]);
