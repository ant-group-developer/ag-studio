import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import { DurationInput, formatDuration, splitSeconds } from "./DurationInput";

describe("splitSeconds / formatDuration", () => {
  it("splits seconds into hours, minutes and seconds", () => {
    expect(splitSeconds(0)).toEqual({ h: 0, m: 0, s: 0 });
    expect(splitSeconds(90)).toEqual({ h: 0, m: 1, s: 30 });
    expect(splitSeconds(3600)).toEqual({ h: 1, m: 0, s: 0 });
    expect(splitSeconds(3725)).toEqual({ h: 1, m: 2, s: 5 });
  });

  it("names only the parts that are not zero", () => {
    const units = { h: "giờ", m: "phút", s: "giây" };
    expect(formatDuration(3725, units)).toBe("1 giờ 2 phút 5 giây");
    expect(formatDuration(300, units)).toBe("5 phút");
    expect(formatDuration(0, units)).toBe("0 giây");
  });
});

describe("DurationInput", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("vi");
  });

  it("shows a value as hours, minutes and seconds", () => {
    render(<DurationInput value={3725} />);
    expect((screen.getByLabelText("giờ") as HTMLInputElement).value).toBe("1");
    expect((screen.getByLabelText("phút") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("giây") as HTMLInputElement).value).toBe("5");
  });

  it("reports the total in seconds when one part changes", () => {
    const onChange = vi.fn();
    render(<DurationInput value={300} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("giây"), { target: { value: "30" } });
    expect(onChange).toHaveBeenLastCalledWith(330);
    fireEvent.change(screen.getByLabelText("giờ"), { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith(3900);
  });

  it("starts empty and reports seconds from the first part typed", () => {
    const onChange = vi.fn();
    render(<DurationInput onChange={onChange} />);
    expect((screen.getByLabelText("phút") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("phút"), { target: { value: "5" } });
    expect(onChange).toHaveBeenLastCalledWith(300);
  });
});
