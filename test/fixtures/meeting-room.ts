// The worked example of SPEC-A-001 ("จองห้องประชุม"). All text is invented — no client data.
// Applied as one change set; the order below makes the keys come out as the SPEC shows them.
import type { PartKind } from "../../src/spec/registry";
import type { Cause, Change } from "../../src/spec/types";

const origin = { stamp: "operator", date: "2026-10-08" } as const;

export const meetingRoomCause: Cause = { kind: "operator" };

const part = (ref: string, kind: PartKind, title: string, body: Record<string, unknown> = {}): Change =>
  ({ op: "part.add", ref, kind, title, body, origin });
const link = (kind: Extract<Change, { op: "link.add" }>["kind"], from: string, to: string, label?: string): Change =>
  ({ op: "link.add", kind, from, to, origin, ...(label ? { label } : {}) });

// [ref, step, from, to, text, carries]
const interactions: [string, string, string, string, string, string?][] = [
  ["$int1", "$step1", "$role1", "$scr1", "เลือกวันที่"],
  ["$int2", "$step1", "$scr1", "$api1", "ขอรายการห้องว่าง"],
  ["$int3", "$step1", "$api1", "$sys1", "อ่านห้องว่างจากปฏิทิน", "$data1"],
  ["$int4", "$step2", "$role1", "$scr1", "เลือกห้องและช่วงเวลา"],
  ["$int5", "$step2", "$scr1", "$scr2", "เปิดหน้ายืนยันพร้อมห้องที่เลือก"],
  ["$int6", "$step3", "$role1", "$scr2", "กดยืนยันการจอง"],
  ["$int7", "$step3", "$scr2", "$api2", "ส่ง Booking", "$data2"],
  ["$int8", "$step3", "$api2", "$sys1", "ตรวจเวลาว่างและบันทึก"],
  ["$int9", "$step3", "$api2", "$scr2", "201 · status pending | confirmed"],
  ["$int10", "$step4", "$role2", "$scr3", "เปิดคำขอแล้วกดอนุมัติหรือปฏิเสธ"],
  ["$int11", "$step4", "$scr3", "$api3", "ส่งผลการพิจารณา"],
  ["$int12", "$step4", "$api3", "$sys1", "อัปเดตสถานะการจอง", "$data2"],
  ["$int13", "$step5", "$scr2", "$role1", "แสดงว่าการจองสำเร็จ"],
  ["$int14", "$step6", "$scr2", "$role1", "แสดงว่าถูกปฏิเสธ พร้อมเหตุผล"],
];

const steps: [string, string, boolean][] = [
  ["$step1", "ค้นหาห้องว่าง", false],
  ["$step2", "เลือกห้องและเวลา", false],
  ["$step3", "ส่งคำขอจอง", false],
  ["$step4", "ผู้ดูแลพิจารณา", false],
  ["$step5", "ได้รับการยืนยัน", true],
  ["$step6", "แจ้งว่าถูกปฏิเสธ", true],
];

export const meetingRoom: Change[] = [
  part("$role1", "role", "พนักงาน"),
  part("$role2", "role", "ผู้ดูแลห้อง"),
  part("$scr1", "screen", "หน้าค้นหาห้อง"),
  part("$scr2", "screen", "หน้ายืนยันการจอง"),
  part("$scr3", "screen", "หน้าอนุมัติคำขอ"),
  part("$api1", "api", "ค้นหาห้องว่าง", { method: "GET", path: "/rooms" }),
  part("$api2", "api", "สร้างการจอง", { method: "POST", path: "/bookings" }),
  part("$api3", "api", "อนุมัติการจอง", { method: "POST", path: "/bookings/{id}/approve" }),
  part("$sys1", "system", "ระบบปฏิทิน"),
  part("$data1", "data", "Room"),
  part("$data2", "data", "Booking"),
  part("$work1", "work", "จองห้องประชุม"),
  ...steps.map(([ref, title, ends]) => part(ref, "step", title, { ends })),
  ...steps.map(([ref]) => link("has_step", "$work1", ref)),
  ...interactions.map(([ref, , , , text]) => part(ref, "interaction", text, { text })),
  ...interactions.flatMap(([ref, step, from, to, , carries]) => [
    link("has_interaction", step, ref),
    link("from", ref, from),
    link("to", ref, to),
    ...(carries ? [link("carries", ref, carries)] : []),
  ]),
  link("next", "$step1", "$step2"),
  link("next", "$step2", "$step3"),
  link("next", "$step3", "$step4", "ห้องใหญ่ ต้องอนุมัติ"),
  link("next", "$step3", "$step5", "ห้องเล็ก ไม่ต้องอนุมัติ"),
  link("next", "$step4", "$step5", "อนุมัติ"),
  link("next", "$step4", "$step6", "ปฏิเสธ"),
  link("reads", "$api1", "$data1"),
  link("writes", "$api2", "$data2"),
  link("writes", "$api3", "$data2"),
  link("shows", "$scr1", "$data1"),
  link("shows", "$scr2", "$data2"),
  link("shows", "$scr3", "$data2"),
  part("$dec1", "decision", "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ", {
    rule: "ห้องที่จุเกิน 10 คนต้องให้ผู้ดูแลอนุมัติ",
    cases: ["ห้องใหญ่ → ผู้ดูแลอนุมัติ", "ห้องเล็ก → ยืนยันทันที"],
    open: "ห้องพอดี 10 คน",
  }),
  link("covers", "$dec1", "$step3"),
  link("covers", "$dec1", "$step4"),
  part("$q1", "question", "ผู้ดูแลไม่ตอบใน 24 ชม. ทำอย่างไร", {
    text: "ผู้ดูแลไม่ตอบใน 24 ชม. ทำอย่างไร",
    proposedAnswer: "ยกเลิกอัตโนมัติและแจ้งพนักงาน",
    status: "open",
  }),
  link("about", "$q1", "$step4"),
];

// Answers Q-001 with its full body (a given body replaces the stored one — SPEC-A-001).
export const answerQ001: Change = {
  op: "part.update",
  key: "Q-001",
  body: {
    text: "ผู้ดูแลไม่ตอบใน 24 ชม. ทำอย่างไร",
    proposedAnswer: "ยกเลิกอัตโนมัติและแจ้งพนักงาน",
    status: "answered",
    answer: "ยกเลิกอัตโนมัติและแจ้งพนักงาน",
  },
};
