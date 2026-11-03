use super::*;

#[derive(Default)]
pub(super) struct DeviceStats {
    pub(super) sent: u32,
    pub(super) received: u32,
    pub(super) last_received_at: Option<f64>,
    pub(super) delta_sum_ms: f64,
    pub(super) delta_sq_sum_ms: f64,
    pub(super) delta_count: u32,
}

impl DeviceStats {
    pub(super) fn record_received(&mut self) {
        self.received += 1;
        let now = now_millis();
        if let Some(last) = self.last_received_at {
            let delta = now - last;
            self.delta_sum_ms += delta;
            self.delta_sq_sum_ms += delta * delta;
            self.delta_count += 1;
        }
        self.last_received_at = Some(now);
    }

    /// Standard deviation of inter-arrival time over the current window — a
    /// cheap jitter proxy, not RFC 3550's EWMA jitter estimator.
    pub(super) fn jitter_ms(&self) -> f64 {
        if self.delta_count == 0 {
            return 0.0;
        }
        let mean = self.delta_sum_ms / self.delta_count as f64;
        let variance = (self.delta_sq_sum_ms / self.delta_count as f64) - mean * mean;
        variance.max(0.0).sqrt()
    }

    pub(super) fn mean_interval_ms(&self) -> f64 {
        if self.delta_count == 0 {
            0.0
        } else {
            self.delta_sum_ms / self.delta_count as f64
        }
    }

    pub(super) fn reset_window(&mut self) {
        self.sent = 0;
        self.received = 0;
        self.delta_sum_ms = 0.0;
        self.delta_sq_sum_ms = 0.0;
        self.delta_count = 0;
    }
}
