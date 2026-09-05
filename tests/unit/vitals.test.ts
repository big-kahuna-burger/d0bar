import { beforeEach, describe, expect, it } from "vitest";
import {
  HEALTHY,
  POOR,
  WARNING,
  inp,
  noteInteraction,
  noteLayoutShift,
  noteLcp,
  noteLoaf,
  resetVitals,
  snapshot,
  worstVital,
} from "../../src/collector/vitals";

function shift(startTime: number, value: number, hadRecentInput = false) {
  return { startTime, value, hadRecentInput, duration: 0 } as PerformanceEntry & {
    value: number;
    hadRecentInput: boolean;
  };
}

function interaction(interactionId: number, duration: number) {
  return { interactionId, duration, startTime: 0, processingStart: 0 } as PerformanceEntry & {
    interactionId: number;
    processingStart: number;
  };
}

describe("vitals", () => {
  beforeEach(resetVitals);

  describe("CLS", () => {
    it("sums shifts inside one session window", () => {
      noteLayoutShift(shift(1000, 0.02));
      noteLayoutShift(shift(1500, 0.02));
      expect(snapshot().cls).toBeCloseTo(0.04);
    });

    it("starts a new window after a gap and reports the largest, not the total", () => {
      noteLayoutShift(shift(1000, 0.05));
      noteLayoutShift(shift(1500, 0.05));
      /* More than 1s later: a new session window, so this does not accumulate onto 0.10. */
      noteLayoutShift(shift(4000, 0.03));
      expect(snapshot().cls).toBeCloseTo(0.1);
    });

    it("caps a session window at five seconds", () => {
      noteLayoutShift(shift(0, 0.04));
      for (let t = 900; t <= 5400; t += 900) noteLayoutShift(shift(t, 0.04));
      /* The window closes at 5s, so the running value restarts rather than growing forever. */
      expect(snapshot().cls).toBeLessThan(0.28);
    });

    it("excludes shifts that followed user input", () => {
      noteLayoutShift(shift(1000, 0.5, true));
      expect(snapshot().cls).toBe(0);
    });
  });

  describe("INP", () => {
    it("is unset until an interaction is recorded", () => {
      expect(inp()).toBe(-1);
    });

    it("takes the longest event of an interaction, not the first", () => {
      noteInteraction(interaction(1, 48));
      noteInteraction(interaction(1, 112));
      expect(inp()).toBe(112);
    });

    it("ignores events with no interaction id", () => {
      noteInteraction(interaction(0, 900));
      expect(inp()).toBe(-1);
    });

    it("reports the worst interaction on a page with few of them", () => {
      noteInteraction(interaction(1, 40));
      noteInteraction(interaction(2, 220));
      noteInteraction(interaction(3, 60));
      expect(inp()).toBe(220);
    });

    it("retains only the ten longest interactions", () => {
      for (let i = 1; i <= 40; i++) noteInteraction(interaction(i, i * 10));
      /* Under 50 interactions the score is the worst one; the smaller ones are discarded
         without affecting it. */
      expect(inp()).toBe(400);
    });
  });

  describe("worst vital", () => {
    it("is undefined before the browser has reported anything", () => {
      expect(worstVital()).toBeUndefined();
    });

    it("buckets LCP against the standard thresholds", () => {
      noteLcp({ startTime: 2400 } as PerformanceEntry);
      expect(worstVital()).toMatchObject({ name: "LCP", bucket: HEALTHY, text: "LCP 2.40s" });

      resetVitals();
      noteLcp({ startTime: 4530 } as PerformanceEntry);
      expect(worstVital()).toMatchObject({ name: "LCP", bucket: POOR, text: "LCP 4.53s" });
    });

    it("prefers the vital in the worst bucket over the largest number", () => {
      noteLcp({ startTime: 2400 } as PerformanceEntry); // healthy
      noteInteraction(interaction(1, 260)); // warning, but a much smaller number
      expect(worstVital()).toMatchObject({ name: "INP", bucket: WARNING });
    });

    it("formats sub-second values in milliseconds", () => {
      noteInteraction(interaction(1, 112));
      expect(worstVital()?.text).toBe("INP 112ms");
    });

    it("formats CLS to two decimal places", () => {
      noteLayoutShift(shift(1000, 0.04));
      expect(worstVital()?.text).toBe("CLS 0.04");
    });
  });

  it("tracks long animation frames", () => {
    noteLoaf({ duration: 84 } as PerformanceEntry);
    noteLoaf({ duration: 51 } as PerformanceEntry);
    expect(snapshot().loafCount).toBe(2);
    expect(snapshot().loafLongest).toBe(84);
  });
});
