/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type NivrisSettings } from "./types";

/**
 * The three AI outputs that are meant to look the same every time you generate them — the session
 * analysis, the thread summary and the end-of-day report. Each one's instruction block lives here
 * as an editable template instead of being hardcoded at its call site, so the user can pin down
 * the shape of the output (sections, bullet count, tone, language) once and have every run come
 * back in that shape.
 */
export type NivrisTemplateKey = "insights" | "thread" | "report";

export interface NivrisTemplateMeta {
    key: NivrisTemplateKey;
    label: string;
    /** What this output is, in the settings UI. */
    hint: string;
    /** Placeholders this template may use, for the settings UI to list. */
    placeholders: string[];
}

export const NIVRIS_TEMPLATE_META: NivrisTemplateMeta[] = [
    {
        key: "insights",
        label: "PHÂN TÍCH SESSION",
        hint: 'Đầu ra của nút "Phân tích" trong mỗi session.',
        placeholders: ["{{tracker}}"],
    },
    {
        key: "thread",
        label: "TÓM TẮT THREAD",
        hint: 'Đầu ra của nút "Tóm tắt" khi mở một tin nằm trong thread.',
        placeholders: [],
    },
    {
        key: "report",
        label: "BÁO CÁO CUỐI NGÀY",
        hint: "Đầu ra của màn báo cáo, cho từng người được gắn vào báo cáo.",
        placeholders: ["{{who}}", "{{role}}", "{{sections}}"],
    },
];

/** Shared house rules, prepended to all three so they stay consistent with each other. */
export const DEFAULT_OUTPUT_STYLE = [
    "Viết bằng tiếng Việt.",
    "Bám CHỈ vào transcript được cung cấp — không suy đoán, không bịa thông tin ngoài transcript.",
    "Câu ngắn, cụ thể, không văn vẻ, không mở bài/kết bài.",
].join("\n");

export const DEFAULT_TEMPLATES: Record<NivrisTemplateKey, string> = {
    insights: [
        "Bạn là trợ lý N.I.V.R.I.S. đang phân tích các tin nhắn liên quan tới session {{tracker}}.",
        "Viết tối đa 8 nhận định, mỗi nhận định 1 dòng, không đánh số.",
        "Mỗi nhận định nên cụ thể — nêu rõ ai nói gì, ở phòng nào, và thời điểm nếu liên quan — thay vì chỉ tóm tắt chung chung.",
        "Ưu tiên nêu: các câu hỏi/yêu cầu đang chờ người dùng phản hồi, deadline hoặc mốc thời gian được nhắc tới, việc cần làm (action item) và ai chịu trách nhiệm, các quyết định hoặc thay đổi quan trọng, và bất kỳ mâu thuẫn/vấn đề chưa giải quyết.",
        "Nếu transcript ít nội dung, ít nhận định hơn cũng được — không thêm nhận định thừa để đủ số lượng.",
    ].join("\n"),
    thread: [
        "Bạn là trợ lý N.I.V.R.I.S. đang tóm tắt một thread tin nhắn.",
        "Đọc TOÀN BỘ transcript và viết tối đa 8 gạch đầu dòng, mỗi dòng 1 ý, không đánh số.",
        "Ưu tiên nêu: thread đang bàn về chuyện gì, các quyết định/kết luận đã chốt, việc cần làm và ai chịu trách nhiệm, deadline nếu có, và câu hỏi/việc còn chưa được trả lời.",
        "Nếu transcript ít nội dung, ít gạch đầu dòng hơn cũng được — không thêm ý thừa cho đủ số lượng.",
    ].join("\n"),
    report: [
        'Bạn là trợ lý N.I.V.R.I.S. đang viết báo cáo cuối ngày cho {{who}} dựa trên tin nhắn của họ hôm nay.',
        "Lưu ý vai trò/vị trí công việc của người này là {{role}} khi diễn giải nội dung — báo cáo của quản lý thường là chỉ đạo/quyết định, còn báo cáo của nhân viên thường là tiến độ việc được giao.",
        "Trả lời theo đúng các mục sau, mỗi mục là các gạch đầu dòng ngắn gọn, cụ thể (nêu rõ việc gì, ở phòng nào nếu cần):",
        "",
        "{{sections}}",
        "",
        "Nếu 1 mục không có thông tin trong transcript, ghi 'Không có thông tin' cho mục đó thay vì bỏ trống hoặc bịa ra.",
    ].join("\n"),
};

/**
 * Fills {{placeholders}} and drops any line whose placeholder resolved to nothing — that's what
 * lets the report template carry a "vai trò là {{role}}" line that simply disappears for someone
 * with no job title set, instead of rendering "vai trò là undefined" into the prompt.
 */
export function fillTemplate(template: string, values: Record<string, string | undefined>): string {
    return template
        .split("\n")
        .map((line) => {
            let dropped = false;
            const filled = line.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
                const value = values[name];
                if (value === undefined || value === "") {
                    dropped = true;
                    return "";
                }
                return value;
            });
            return dropped ? null : filled;
        })
        .filter((line): line is string => line !== null)
        .join("\n");
}

/**
 * The instruction block for one output: the user's house style (or the default one) followed by
 * the user's template for this output (or the default one). A blank override means "use the
 * default", so clearing a box in settings restores stock behaviour without a separate reset flag.
 */
export function buildSystemPrompt(
    settings: NivrisSettings,
    key: NivrisTemplateKey,
    values: Record<string, string | undefined> = {},
): string {
    const style = (settings.outputStyle ?? "").trim() || DEFAULT_OUTPUT_STYLE;
    const template = (settings.outputTemplates?.[key] ?? "").trim() || DEFAULT_TEMPLATES[key];
    return [fillTemplate(template, values), "", style].join("\n");
}
