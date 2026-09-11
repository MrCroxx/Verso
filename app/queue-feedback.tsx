"use client";

import { createContext, useContext, useState, type Dispatch, type SetStateAction, type ReactNode } from "react";

type QueueNotice = { bookName: string; error: string } | null;
const QueueFeedbackContext = createContext<{ notice: QueueNotice; setNotice: Dispatch<SetStateAction<QueueNotice>> } | null>(null);

export function QueueFeedbackProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<QueueNotice>(null);
  return <QueueFeedbackContext.Provider value={{ notice, setNotice }}>{children}</QueueFeedbackContext.Provider>;
}

export function useQueueFeedback() {
  const value = useContext(QueueFeedbackContext);
  if (!value) throw new Error("useQueueFeedback must be used inside QueueFeedbackProvider.");
  return value;
}
