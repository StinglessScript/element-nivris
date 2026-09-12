/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { EventEmitter } from "events";

export const NIVRIS_REPORT_STORE_CHANGE_EVENT = "change";

const STORAGE_KEY = "mx_nivris_reports";

/** Local calendar day, "YYYY-MM-DD" — not toISOString(), which would roll over at UTC midnight. */
export function reportDateKey(d: Date = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Moves a "YYYY-MM-DD" key by whole days, via Date so month/year and DST roll over correctly. */
export function shiftDateKey(dateKey: string, days: number): string {
    const [y, m, d] = dateKey.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return reportDateKey(date);
}

/** [start, end) timestamps of a "YYYY-MM-DD" key in local time. */
export function dayRange(dateKey: string): { from: number; to: number } {
    const [y, m, d] = dateKey.split("-").map(Number);
    const from = new Date(y, m - 1, d).getTime();
    return { from, to: from + 86_400_000 };
}

export function formatReportDate(dateKey: string): string {
    const [y, m, d] = dateKey.split("-").map(Number);
    if (!y || !m || !d) return dateKey;
    const date = new Date(y, m - 1, d);
    const today = reportDateKey();
    const yesterday = reportDateKey(new Date(Date.now() - 86_400_000));
    const label = date.toLocaleDateString("vi-VN", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
    if (dateKey === today) return `Hôm nay · ${label}`;
    if (dateKey === yesterday) return `Hôm qua · ${label}`;
    return label;
}

export interface NivrisStoredReport {
    trackerId: string;
    /** Snapshot of who the report was about, so an archived day still reads correctly after the
     * tracker is renamed or removed. */
    trackerLabel: string;
    roleLabel?: string;
    text: string;
    generatedAt: number;
}

type ReportArchive = Record<string, Record<string, NivrisStoredReport>>;

function load(): ReportArchive {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as ReportArchive) : {};
    } catch {
        return {};
    }
}

function save(archive: ReportArchive): void {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(archive));
}

/**
 * Keeps every generated end-of-day report, filed by local calendar day, so the report screen can
 * be browsed backwards instead of only ever showing the newest generation. Reports used to live on
 * the tracker itself as a single field that each new run overwrote — one regeneration and
 * yesterday's write-up was gone.
 */
class NivrisReportStore extends EventEmitter {
    private static internalInstance: NivrisReportStore;

    private archive: ReportArchive = load();

    private constructor() {
        super();
    }

    public static get instance(): NivrisReportStore {
        if (!NivrisReportStore.internalInstance) {
            NivrisReportStore.internalInstance = new NivrisReportStore();
        }
        return NivrisReportStore.internalInstance;
    }

    /** Dates that have at least one report, newest first. */
    public getDates(): string[] {
        return Object.keys(this.archive)
            .filter((d) => Object.keys(this.archive[d] ?? {}).length > 0)
            .sort()
            .reverse();
    }

    public getForDate(dateKey: string): NivrisStoredReport[] {
        return Object.values(this.archive[dateKey] ?? {}).sort((a, b) => a.generatedAt - b.generatedAt);
    }

    public get(dateKey: string, trackerId: string): NivrisStoredReport | undefined {
        return this.archive[dateKey]?.[trackerId];
    }

    public setReport(dateKey: string, report: NivrisStoredReport): void {
        this.archive = { ...this.archive, [dateKey]: { ...(this.archive[dateKey] ?? {}), [report.trackerId]: report } };
        save(this.archive);
        this.emit(NIVRIS_REPORT_STORE_CHANGE_EVENT);
    }

    public removeDate(dateKey: string): void {
        if (!this.archive[dateKey]) return;
        const next = { ...this.archive };
        delete next[dateKey];
        this.archive = next;
        save(this.archive);
        this.emit(NIVRIS_REPORT_STORE_CHANGE_EVENT);
    }
}

export default NivrisReportStore;
