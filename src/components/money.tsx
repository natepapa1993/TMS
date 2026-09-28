"use client";

import { createContext, useContext } from "react";

/**
 * Whether the signed-in person sees what the customer pays and the margin (the owner can hide them from dispatchers).
 * Provided once by the (app) layout; the board, planner and load page read it.
 */
const MoneyContext = createContext(true);
export const MoneyProvider = MoneyContext.Provider;
export const useShowMoney = () => useContext(MoneyContext);
