export interface AttlogRecord {
  deviceUserId: string;
  timestamp: Date; // Parsed from device local time string; stored as-is (workspace TZ assumed IST)
  statusCode: number;
  verifyCode: number;
}
