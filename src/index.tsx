/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React from "react";
import AiIcon from "@vector-im/compound-design-tokens/assets/web/icons/ai";

import type { Module, Api, ModuleFactory } from "@element-hq/element-web-module-api";
import NivrisWorkspace from "./components/NivrisWorkspace";
import NivrisUpdateBanner from "./components/NivrisUpdateBanner";
import { startThreadPanelIconInjector } from "./nivris/threadPanelInjector";
import { setModuleApi } from "./nivris/moduleApi";
import style from "./style.css" with { type: "css" };

const LOCATION_PATH = "nivris";
const SPACE_KEY = "nivris";

class NivrisModule implements Module {
    public static readonly moduleApiVersion = "^1.0.0";

    public constructor(private api: Api) {}

    public async load(): Promise<void> {
        document.adoptedStyleSheets.push(style);
        setModuleApi(this.api);

        this.api.navigation.registerLocationRenderer(LOCATION_PATH, () => <NivrisWorkspace />);

        this.api.extras.setSpacePanelItem(SPACE_KEY, {
            icon: <AiIcon />,
            label: "N.I.V.R.I.S.",
            tooltip: "N.I.V.R.I.S. — Neural Intelligence & Virtual Reasoning Interface System",
            onSelected: () => {
                // Reported live and confirmed by direct testing: going straight from a room view to
                // "nivris" leaves Element's RoomViewStore thinking that room is still current, which
                // yanks the view back to it moments later if a threaded message was opened via "Mở
                // trong Element" first. Switching to any *other* real space in between doesn't have
                // this problem — that transition properly tears down the active-room state, nivris's
                // custom space-panel item apparently doesn't trigger the same cleanup on its own.
                // Bounce through the home screen first to get that same teardown for free, instead
                // of relying on the user to manually detour through another space every time.
                //
                // The bounce itself is a real screen change though, so without masking it the user
                // sees a home-screen flash before Nivris appears — reported live as "quá tệ về trải
                // nghiệm". Cover it with a solid overlay for the (~150ms) duration of the detour so
                // only the final "arrived at Nivris" moment is visible, not the intermediate hop.
                const overlay = document.createElement("div");
                overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:var(--jv-bg,#0b1416);";
                document.body.appendChild(overlay);
                window.location.hash = "#/";
                window.setTimeout(() => {
                    window.location.hash = `#/${LOCATION_PATH}`;
                    window.setTimeout(() => overlay.remove(), 90);
                }, 60);
            },
        });

        // Without this, Element has no way to know the "nivris" space never shows a room — its own
        // docs on this method say exactly that gap makes it "redirect to display the room in its
        // vanilla space/metaspace" instead. Reported live: opening a threaded message via "Mở
        // trong Element" then switching back to Nivris got yanked back to the room ~1.7s later, on
        // every attempt — but the same open-thread-then-switch-space sequence was fine switching to
        // any *other* space, which only makes sense if Element still considered that room "current"
        // specifically while the nivris space was active (an empty visible-room list is accurate:
        // no room is ever shown *inside* the nivris space itself).
        this.api.extras.getVisibleRoomBySpaceKey(SPACE_KEY, () => []);

        startThreadPanelIconInjector(this.api);

        const bannerHost = document.createElement("div");
        document.body.appendChild(bannerHost);
        this.api.createRoot(bannerHost).render(<NivrisUpdateBanner />);
    }
}

export default NivrisModule satisfies ModuleFactory;
