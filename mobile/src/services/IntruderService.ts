import { CameraView } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library';
import * as FileSystem from 'expo-file-system';
import { IntruderRecord } from '../types';
import { NotificationService } from './NotificationService';

const INTRUDER_FOLDER = FileSystem.documentDirectory + 'intruder_photos/';
const ATTEMPTS_KEY = 'intruder_attempts';

export class IntruderService {
  private static attemptCount = 0;
  private static cameraRef: CameraView | null = null;

  static setCameraRef(ref: CameraView | null) {
    this.cameraRef = ref;
  }

  static resetAttempts() {
    this.attemptCount = 0;
  }

  static async captureIntruderPhoto(maxAttempts: number): Promise<IntruderRecord | null> {
    this.attemptCount++;

    if (this.attemptCount >= maxAttempts && this.cameraRef) {
      try {
        await FileSystem.makeDirectoryAsync(INTRUDER_FOLDER, { intermediates: true });

        const photo = await (this.cameraRef as any).takePictureAsync({
          quality: 0.7,
          base64: false,
          skipProcessing: true,
          mirror: true, // Front camera mirror
        });

        const filename = `intruder_${Date.now()}.jpg`;
        const destPath = INTRUDER_FOLDER + filename;

        await FileSystem.moveAsync({ from: photo.uri, to: destPath });

        // Save to media library for easy access
        try {
          const asset = await MediaLibrary.createAssetAsync(destPath);
          let album = await MediaLibrary.getAlbumAsync('AP FocusLock - Intruders');
          if (!album) {
            await MediaLibrary.createAlbumAsync('AP FocusLock - Intruders', asset, false);
          } else {
            await MediaLibrary.addAssetsToAlbumAsync([asset], album, false);
          }
        } catch {
          // Media library save optional
        }

        await NotificationService.scheduleIntruderAlert(this.attemptCount);

        const record: IntruderRecord = {
          id: `intruder_${Date.now()}`,
          photoUri: destPath,
          timestamp: new Date().toISOString(),
          attemptType: 'pin',
        };

        this.attemptCount = 0;
        return record;
      } catch {
        return null;
      }
    }

    if (this.attemptCount >= maxAttempts) {
      await NotificationService.scheduleIntruderAlert(this.attemptCount);
      this.attemptCount = 0;
    }

    return null;
  }

  static getAttemptCount(): number {
    return this.attemptCount;
  }

  static async deletePhoto(uri: string): Promise<void> {
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {}
  }
}
