# Synthetic (2026-10-07, tools/test-live-snapshot.mjs): three metric names a
# service declares — two the recorded inventory lists under the snapshot's
# prefixes, one outside them.
from prometheus_client import Counter

NOTIFICATIONS = Counter('alertmanager_notifications_total', 'Notifications sent')
RECEIVED = Counter('alertmanager_alerts_received_total', 'Alerts received')
ORDERS = Counter('checkout_orders_total', 'Orders placed')
