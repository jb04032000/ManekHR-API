import { Attendance } from '../schemas/attendance.schema';

export interface AttendanceResult {
  record: Attendance;
}

export interface BulkAttendanceResult {
  records: Attendance[];
}
