/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type Dispatch, useCallback, useState } from "react";

const getValue = <T>(key: string, initialValue: T): T => {
    try {
        const item = window.localStorage.getItem(key);
        return item ? JSON.parse(item) : initialValue;
    } catch {
        return initialValue;
    }
};

/** Same shape as useState, but persisted to localStorage under a "mx_nivris_" prefixed key. */
export const useLocalStorageState = <T>(key: string, initialValue: T): [T, Dispatch<T>] => {
    const lsKey = "mx_nivris_" + key;
    const [value, setValue] = useState<T>(() => getValue(lsKey, initialValue));

    const _setValue: Dispatch<T> = useCallback(
        (v: T) => {
            window.localStorage.setItem(lsKey, JSON.stringify(v));
            setValue(v);
        },
        [lsKey],
    );

    return [value, _setValue];
};
