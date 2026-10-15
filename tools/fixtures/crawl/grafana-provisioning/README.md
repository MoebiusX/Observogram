# Grafana unified-alerting provisioning fixture

`alert-rules.yaml` is the shape `grafana/provisioning/alerting/*.yaml` takes
when a Grafana alert-rule export is written back by other tooling:

- the queries live in `groups[].rules[].data[].model`, as a YAML mapping
  (Grafana's own export) or as a JSON string (HTTP provisioning API payloads,
  Terraform `jsonencode`);
- non-ASCII text in annotations is written with YAML `\xHH` / `\uHHHH`
  escapes (PyYAML's default `allow_unicode=False`), which JSON does not have.

One rule carries a model JSON string that does not parse. The crawler must
keep the file and its other rules, and say how many rules it lost.
Read by tools/test-crawl.mjs; not a golden input.
