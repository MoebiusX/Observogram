package hostile.event;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;

public class EventMetrics {
    private final Counter published;

    public EventMetrics(MeterRegistry registry) {
        this.published = Counter.builder("published_total").description("events published").register(registry);
    }
}
