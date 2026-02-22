// server/baseline.js
// Rolling statistical baseline using 30-day history.
// Flags deviations at 2 standard deviations from the user's personal mean.

const DEVIATION_THRESHOLD = 2.0; // standard deviations

/**
 * Analyze a health snapshot against the user's baseline.
 * Returns an anomaly object describing what's off, or null if everything looks normal.
 *
 * @param {Object} snapshot - Today's health metrics from Apple Watch
 * @param {Object|null} baseline - Rolling 30-day stats, null if not enough history
 * @returns {Object|null} anomaly descriptor or null
 */
export function analyzeSnapshot(snapshot, baseline) {
  // Need at least 7 days of history before making judgments
  if (!baseline || baseline.sampleCount < 7) {
    return null;
  }

  const weekday = snapshot.weekday; // 1=Sunday, 7=Saturday
  const isWeekday = weekday >= 2 && weekday <= 6;

  // ── Check 1: Late wake time on a weekday ──────────────────────────────────
  if (
    isWeekday &&
    snapshot.wake_time_hour != null &&
    baseline.wakeTime.mean != null &&
    baseline.wakeTime.stddev > 0
  ) {
    const z = zScore(snapshot.wake_time_hour, baseline.wakeTime.mean, baseline.wakeTime.stddev);
    if (z > DEVIATION_THRESHOLD) {
      const extraMinutes = Math.round((snapshot.wake_time_hour - baseline.wakeTime.mean) * 60);
      return {
        type: 'late_wake',
        zScore: z,
        context: {
          isWeekday,
          extraMinutes,
          usualWakeHour: baseline.wakeTime.mean,
          actualWakeHour: snapshot.wake_time_hour,
        },
      };
    }
  }

  // ── Check 2: Short sleep ──────────────────────────────────────────────────
  if (
    snapshot.sleep_duration_hours != null &&
    baseline.sleepDuration.mean != null &&
    baseline.sleepDuration.stddev > 0
  ) {
    const z = zScore(snapshot.sleep_duration_hours, baseline.sleepDuration.mean, baseline.sleepDuration.stddev);
    if (z < -DEVIATION_THRESHOLD) {
      const shortByHours = +(baseline.sleepDuration.mean - snapshot.sleep_duration_hours).toFixed(1);
      return {
        type: 'short_sleep',
        zScore: z,
        context: {
          shortByHours,
          usualHours: +baseline.sleepDuration.mean.toFixed(1),
          actualHours: +snapshot.sleep_duration_hours.toFixed(1),
        },
      };
    }
  }

  // ── Check 3: Skipped run / workout ────────────────────────────────────────
  // Only flag if user typically runs most days (>60% frequency)
  if (
    baseline.runFrequency != null &&
    baseline.runFrequency > 0.6 &&
    snapshot.running_minutes === 0
  ) {
    // Check what time it is — only flag after user's typical run window
    const currentHour = new Date().getHours();
    const typicalRunHour = baseline.typicalRunHour ?? 9;

    if (currentHour > typicalRunHour + 3) {
      return {
        type: 'skipped_run',
        context: {
          runFrequency: baseline.runFrequency,
          typicalRunHour,
        },
      };
    }
  }

  // ── Check 4: Elevated resting heart rate ──────────────────────────────────
  if (
    snapshot.resting_hr != null &&
    baseline.restingHR.mean != null &&
    baseline.restingHR.stddev > 0
  ) {
    const z = zScore(snapshot.resting_hr, baseline.restingHR.mean, baseline.restingHR.stddev);
    if (z > DEVIATION_THRESHOLD) {
      return {
        type: 'elevated_hr',
        zScore: z,
        context: {
          usualBPM: Math.round(baseline.restingHR.mean),
          actualBPM: Math.round(snapshot.resting_hr),
        },
      };
    }
  }

  // ── Check 5: Unusually short workout ─────────────────────────────────────
  if (
    snapshot.running_minutes > 0 &&
    baseline.workoutDuration.mean != null &&
    baseline.workoutDuration.stddev > 0
  ) {
    const z = zScore(snapshot.running_minutes, baseline.workoutDuration.mean, baseline.workoutDuration.stddev);
    if (z < -DEVIATION_THRESHOLD) {
      return {
        type: 'short_workout',
        zScore: z,
        context: {
          usualMinutes: Math.round(baseline.workoutDuration.mean),
          actualMinutes: Math.round(snapshot.running_minutes),
        },
      };
    }
  }

  return null; // Nothing to flag today — all quiet
}

/**
 * Build a baseline stats object from an array of historical snapshots.
 * Called by store.js when returning baseline data.
 */
export function computeBaseline(snapshots) {
  if (snapshots.length < 3) return null;

  const wakeHours = snapshots.map(s => s.wake_time_hour).filter(v => v != null);
  const sleepDurations = snapshots.map(s => s.sleep_duration_hours).filter(v => v != null);
  const restingHRs = snapshots.map(s => s.resting_hr).filter(v => v != null);
  const runDays = snapshots.filter(s => s.running_minutes > 0);
  const runMinutes = runDays.map(s => s.running_minutes);

  // Estimate typical run hour from workout timestamps (simplified: use snapshot time)
  const typicalRunHour = runDays.length > 0
    ? Math.round(mean(runDays.map(s => new Date(s.timestamp).getHours())))
    : null;

  return {
    sampleCount: snapshots.length,
    wakeTime: stats(wakeHours),
    sleepDuration: stats(sleepDurations),
    restingHR: stats(restingHRs),
    workoutDuration: stats(runMinutes),
    runFrequency: snapshots.length > 0 ? runDays.length / snapshots.length : 0,
    typicalRunHour,
  };
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function zScore(value, mean, stddev) {
  return (value - mean) / stddev;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((acc, v) => acc + Math.pow(v - m, 2), 0) / arr.length;
  return Math.sqrt(variance);
}

function stats(arr) {
  if (!arr.length) return { mean: null, stddev: null };
  return { mean: mean(arr), stddev: stddev(arr) };
}
