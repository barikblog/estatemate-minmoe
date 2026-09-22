package com.estatemate.app.di

import android.content.Context
import androidx.room.Room
import com.estatemate.app.data.local.AccessEventDao
import com.estatemate.app.data.local.AppDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "estatemate.db").build()

    @Provides
    fun accessEventDao(database: AppDatabase): AccessEventDao = database.accessEventDao()
}
