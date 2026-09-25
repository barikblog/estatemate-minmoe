package com.estatemate.app.data.local

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "access_events")
data class CachedAccessEvent(
    @PrimaryKey val id: String,
    val personName: String?,
    val cardUid: String?,
    val deviceName: String?,
    val result: String,
    val deviceTimestamp: String,
)

@Dao
interface AccessEventDao {
    @Query("SELECT * FROM access_events ORDER BY deviceTimestamp DESC LIMIT 100")
    fun observeRecent(): Flow<List<CachedAccessEvent>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun replace(events: List<CachedAccessEvent>)

    @Query("DELETE FROM access_events")
    suspend fun clear()
}

// exportSchema is off because this is a local offline cache with one entity and
// no migration history to preserve; leaving it on without a room.schemaLocation
// makes every build warn about a missing schema export directory.
@Database(entities = [CachedAccessEvent::class], version = 1, exportSchema = false)
abstract class AppDatabase : RoomDatabase() {
    abstract fun accessEventDao(): AccessEventDao
}
