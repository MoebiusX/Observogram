import { Counter } from 'prom-client';
export const a = new Counter({ name: 'a_total', help: 'a', labelNames: ['code'] });
