import { db } from './db'

/**
 * Set a player's event placement and shift other players' ranks so there are no gaps
 * or duplicate ranks (insert/move semantics).
 */
export async function setEventPlacementWithShift(
  eventId: number,
  userId: number,
  placement: number | null
): Promise<number[]> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    const curRes = await client.query<{ placement: number | null }>(
      `SELECT placement FROM event_attendance WHERE user_id = $1 AND event_id = $2`,
      [userId, eventId]
    )
    const oldRaw = curRes.rows[0]?.placement
    const old =
      oldRaw == null || Number(oldRaw) < 1 ? null : Math.floor(Number(oldRaw))

    if (placement !== null) {
      const place = Math.floor(placement)

      if (place !== old) {
        if (old == null) {
          await client.query(
            `UPDATE event_attendance
             SET placement = placement + 1, updated_at = NOW()
             WHERE event_id = $1 AND placement >= $2`,
            [eventId, place]
          )
        } else if (place < old) {
          await client.query(
            `UPDATE event_attendance
             SET placement = placement + 1, updated_at = NOW()
             WHERE event_id = $1 AND placement >= $2 AND placement < $3 AND user_id <> $4`,
            [eventId, place, old, userId]
          )
        } else if (place > old) {
          await client.query(
            `UPDATE event_attendance
             SET placement = placement - 1, updated_at = NOW()
             WHERE event_id = $1 AND placement > $2 AND placement <= $3 AND user_id <> $4`,
            [eventId, old, place, userId]
          )
        }
      }

      await client.query(
        `INSERT INTO event_attendance (user_id, event_id, attended, placement)
         VALUES ($1, $2, TRUE, $3)
         ON CONFLICT (user_id, event_id)
         DO UPDATE SET placement = EXCLUDED.placement, attended = TRUE, updated_at = NOW()`,
        [userId, eventId, place]
      )
    } else {
      if (old != null) {
        await client.query(
          `UPDATE event_attendance
           SET placement = placement - 1, updated_at = NOW()
           WHERE event_id = $1 AND placement > $2`,
          [eventId, old]
        )
      }
      await client.query(
        `INSERT INTO event_attendance (user_id, event_id, attended, placement)
         VALUES ($1, $2, TRUE, NULL)
         ON CONFLICT (user_id, event_id)
         DO UPDATE SET placement = NULL, attended = TRUE, updated_at = NOW()`,
        [userId, eventId]
      )
    }

    const idsRes = await client.query<{ user_id: number }>(
      `SELECT DISTINCT user_id FROM event_attendance WHERE event_id = $1`,
      [eventId]
    )
    await client.query('COMMIT')
    return idsRes.rows.map((r) => Number(r.user_id))
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
