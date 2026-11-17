# dashboard-folders

Where a repository provisions its Grafana dashboards, stated three ways the crawler reads
(`tools/test-crawl.mjs`, "a crawled dashboard states the folder …"):

- `docker-compose.yml` mounts `./grafana/dashboards` at `/var/lib/grafana/dashboards`, and
  `grafana/provisioning/dashboards/providers.yaml` files `…/shop` under the folder `Shop`
  (uid `shop-dash`), `…/teams` by its sub-directories (`foldersFromFilesStructure`), and `…/dup`
  under two providers at once (so neither is chosen);
- `charts/shop/templates/dashboards.yaml` is a sidecar ConfigMap annotated `grafana_folder: Shop Ops`
  holding one dashboard inline, and another annotated `k8s-sidecar-target-directory` shipping the
  chart's `dashboards/*.json` through `.Files.Glob`.

`grafana/dashboards/misc/other.json` is mounted but no provider reads it, and
`deploy/grafana/dashboards/shop/unmounted.json` is in no mounted folder: both state no folder (a
path that merely looks like a provider's is never guessed).
