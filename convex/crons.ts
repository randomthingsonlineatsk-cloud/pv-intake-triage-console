import { cronJobs } from "convex/server"
import { internal } from "./_generated/api"

const crons = cronJobs()

// 03:30 UTC is 09:00 in India, so the team sees reminders at the start of the day.
crons.daily("expedited deadline reminders", { hourUTC: 3, minuteUTC: 30 }, internal.escalations.runScheduled, {})

export default crons
