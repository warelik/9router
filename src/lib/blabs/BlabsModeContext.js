"use client";
import { createContext, useContext, useEffect } from "react";
import { setBlabsBrandify } from "./brandifyText.js";
const BlabsModeContext = createContext(null);
export function BlabsModeProvider({ value, children }) {
  useEffect(() => { setBlabsBrandify(value.brand); return () => setBlabsBrandify(null); }, [value]);
  return <BlabsModeContext.Provider value={value}>{children}</BlabsModeContext.Provider>;
}
export function useBlabsMode() {
  const value = useContext(BlabsModeContext);
  if (!value) throw new Error("useBlabsMode must be used within BlabsModeProvider");
  return value;
}
