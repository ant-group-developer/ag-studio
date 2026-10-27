/**
 * Editing grammar from what each shot is (feedback 2026-10-27 item 9, step 1): the size, camera move and screen
 * direction the scene selection gives a shot (`survey.json` `size`, `motion`, `direction`), checked across the cuts of an
 * edit plan. A shot without them is not judged. Advice, so warnings only. Pure.
 */
import type { CameraMotion, ScreenDirection, ShotSize } from "@harness/contracts";

/** One shot of the cut as the checks read it, in play order. */
export interface GrammarShot {
  order: number;
  source_id: string;
  shot_id: string;
  size?: ShotSize | undefined;
  motion?: CameraMotion | undefined;
  direction?: ScreenDirection | undefined;
}

export interface GrammarIssue { code: "same_size_cut" | "direction_flip" | "pan_clash" | "opening_not_wide" | "size_monotony"; message: string }

export const SHOT_SIZE_NAMES: Record<ShotSize, string> = { wide: "toàn", medium: "trung", close: "cận", detail: "chi tiết" };
/** This many shots in a row of one size read as one long look: the eye wants a change. */
export const SIZE_RUN_MAX = 5;

const OPPOSITE: Partial<Record<ScreenDirection | CameraMotion, string>> = {
  left_to_right: "right_to_left", right_to_left: "left_to_right", pan_left: "pan_right", pan_right: "pan_left",
};
const DIRECTION_NAMES: Record<string, string> = { left_to_right: "trái→phải", right_to_left: "phải→trái", pan_left: "lia trái", pan_right: "lia phải" };

/** The warnings of a cut's shots, in play order. */
export function shotGrammarIssues(shots: readonly GrammarShot[]): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  const first = shots[0];
  if (first?.size === "close" || first?.size === "detail") {
    issues.push({
      code: "opening_not_wide",
      message: `video mở bằng shot ${SHOT_SIZE_NAMES[first.size]} (thứ ${first.order}): người xem chưa biết đang ở đâu — thường mở bằng một shot toàn (establishing) rồi mới vào gần`,
    });
  }
  let run = 1;
  for (let k = 1; k < shots.length; k++) {
    const a = shots[k - 1]!;
    const b = shots[k]!;
    // two pieces of one shot are the jump-cut check's
    if (a.source_id === b.source_id && a.shot_id !== b.shot_id && a.size && a.size === b.size) {
      issues.push({
        code: "same_size_cut",
        message: `shot thứ ${a.order} và ${b.order} cùng nguồn, cùng cỡ ${SHOT_SIZE_NAMES[a.size]}: cắt như vậy trông như hình giật — đổi cỡ (toàn → trung → cận) hoặc chèn một shot nguồn khác vào giữa`,
      });
    }
    if (a.direction && b.direction && OPPOSITE[a.direction] === b.direction) {
      issues.push({
        code: "direction_flip",
        message: `shot thứ ${a.order} chuyển động ${DIRECTION_NAMES[a.direction]}, shot thứ ${b.order} ${DIRECTION_NAMES[b.direction]}: đảo hướng ở chỗ cắt làm người xem lẫn — giữ một hướng, hoặc chèn một shot trung tính (đứng yên, tiến vào) giữa hai shot`,
      });
    }
    if (a.motion && b.motion && OPPOSITE[a.motion] === b.motion) {
      issues.push({
        code: "pan_clash",
        message: `shot thứ ${a.order} ${DIRECTION_NAMES[a.motion]} rồi shot thứ ${b.order} ${DIRECTION_NAMES[b.motion]}: hai lần lia ngược chiều nối nhau làm giật mắt — chọn đoạn đứng yên của một trong hai, hoặc lia cùng chiều`,
      });
    }
    run = a.size && a.size === b.size ? run + 1 : 1;
    if (run === SIZE_RUN_MAX + 1) {
      issues.push({
        code: "size_monotony",
        message: `${run} shot liền nhau đều cỡ ${SHOT_SIZE_NAMES[b.size!]} (tới thứ ${b.order}): xen shot cỡ khác để nhịp hình có lên xuống`,
      });
    }
  }
  return issues;
}
