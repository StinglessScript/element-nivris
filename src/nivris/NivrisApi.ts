/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type NivrisSettings } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";

export class NivrisApiError extends Error {}

interface AnthropicMessageResponse {
    content?: { type: string; text?: string }[];
    error?: { message?: string };
}

export interface NivrisMessage {
    role: "user" | "assistant";
    content: string;
}

/**
 * Calls an Anthropic-compatible `/v1/messages` endpoint and returns the assistant's text reply.
 *
 * The base URL is configurable so this also works against Anthropic-compatible proxies/gateways,
 * not just the official api.anthropic.com endpoint. `messages` carries the full turn history so
 * the model has proper conversational context, not just the latest message in isolation.
 */
export async function askNivris(settings: NivrisSettings, systemPrompt: string, messages: NivrisMessage[]): Promise<string> {
    const baseUrl = settings.baseUrl.trim().replace(/\/+$/, "");
    const url = `${baseUrl}/v1/messages`;

    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": settings.apiKey.trim(),
                "anthropic-version": ANTHROPIC_VERSION,
                // Required by Anthropic to allow calling the API directly from a browser/renderer context.
                "anthropic-dangerous-direct-browser-access": "true",
            },
            body: JSON.stringify({
                model: settings.model.trim(),
                max_tokens: 4096,
                system: systemPrompt,
                messages,
            }),
        });
    } catch (e) {
        throw new NivrisApiError(`Không thể kết nối tới API: ${e instanceof Error ? e.message : String(e)}`);
    }

    let data: AnthropicMessageResponse;
    try {
        data = await res.json();
    } catch {
        throw new NivrisApiError(`Phản hồi không hợp lệ từ API (HTTP ${res.status})`);
    }

    if (!res.ok) {
        throw new NivrisApiError(data.error?.message ?? `Lỗi API (HTTP ${res.status})`);
    }

    const text = data.content?.find((block) => block.type === "text")?.text;
    if (!text) {
        throw new NivrisApiError("API không trả về nội dung văn bản.");
    }
    return text;
}
