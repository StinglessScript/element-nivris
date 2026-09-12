/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * Release notes, shown in Cài đặt → Hệ thống. Kept as data in the bundle rather than fetched from
 * the repo: the changelog for the build you're running has to be readable offline, and it has to
 * describe *that* build — fetching the newest notes from GitHub would show an installed 1.1.0 the
 * release notes of a 1.2.0 it doesn't have.
 *
 * Add a new entry at the TOP and bump package.json's version in the same commit; NIVRIS_VERSION is
 * baked from package.json at build time (see vite.config.ts), so a mismatch between the two shows
 * up immediately as an unlabelled version on the About screen.
 */
export interface NivrisRelease {
    version: string;
    /** "YYYY-MM-DD", the day it was released. */
    date: string;
    changes: string[];
}

/** Semantic version of this build, from package.json. */
export const NIVRIS_VERSION: string = __NIVRIS_VERSION__;

export const NIVRIS_CHANGELOG: NivrisRelease[] = [
    {
        version: "1.1.0",
        date: "2026-09-12",
        changes: [
            'Đánh dấu "đã xem" cho mọi loại session, không riêng session @mention — kèm bộ lọc Chưa xem / Đã xem và nút đánh dấu cả phòng.',
            "Báo cáo cuối ngày được lưu theo ngày và xem lại được: chọn ngày bất kỳ, tạo hoặc tạo lại báo cáo cho ngày đó từ cache tin nhắn.",
            "Cấu hình được định dạng đầu ra của phân tích, tóm tắt thread và báo cáo — một văn phong chung cộng mẫu riêng cho từng loại.",
            "Cài đặt chuyển thành hộp thoại có tab và tự động lưu, không còn nút lưu.",
            "Toàn bộ màu sắc lấy từ design system của Element, chỉ dùng hai nền light/dark mặc định.",
            "Bỏ tính năng Bảng công việc hôm nay.",
            "Tăng tốc màn hình chính: bỏ qua vòng cập nhật khi cửa sổ đang ẩn, không vẽ lại khi số liệu không đổi, và dùng chung dữ liệu đã chuẩn hoá giữa các session.",
        ],
    },
    {
        version: "1.0.0",
        date: "2026-09-01",
        changes: [
            "Bản đầu tiên: theo dõi session theo người / phòng / @mention, phân tích và hỏi đáp bằng AI, báo cáo cuối ngày, nhắc báo công việc và tự cập nhật trong ứng dụng.",
        ],
    },
];
