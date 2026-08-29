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
                window.location.hash = `#/${LOCATION_PATH}`;
            },
        });

        startThreadPanelIconInjector(this.api);

        const bannerHost = document.createElement("div");
        document.body.appendChild(bannerHost);
        this.api.createRoot(bannerHost).render(<NivrisUpdateBanner />);
    }
}

export default NivrisModule satisfies ModuleFactory;
