package com.appartners.focuslock;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;
import android.view.Surface;
import android.graphics.SurfaceTexture;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/**
 * Background service that silently captures an intruder photo
 * when triggered by wrong unlock attempts.
 */
public class IntruderCaptureService extends Service {

    private static final String TAG = "IntruderCapture";
    private static final String CHANNEL_ID = "intruder_detection";

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        createNotificationChannel();
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AP FocusLock")
            .setContentText("Security check chal raha hai...")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .build();
        startForeground(1001, notification);

        int attemptCount = intent != null ? intent.getIntExtra("attempt_count", 1) : 1;
        capturePhoto(attemptCount);

        return START_NOT_STICKY;
    }

    private void capturePhoto(int attemptCount) {
        CameraManager cameraManager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
        HandlerThread handlerThread = new HandlerThread("IntruderCameraThread");
        handlerThread.start();
        Handler handler = new Handler(handlerThread.getLooper());

        try {
            String frontCamId = null;
            for (String id : cameraManager.getCameraIdList()) {
                CameraCharacteristics chars = cameraManager.getCameraCharacteristics(id);
                Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) {
                    frontCamId = id;
                    break;
                }
            }

            if (frontCamId == null) { stopSelf(); return; }

            ImageReader reader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 1);
            String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
            File dir = new File(getFilesDir(), "intruder_photos");
            if (!dir.exists()) dir.mkdirs();
            File file = new File(dir, "intruder_" + timestamp + ".jpg");

            reader.setOnImageAvailableListener(imageReader -> {
                Image image = imageReader.acquireLatestImage();
                if (image != null) {
                    ByteBuffer buf = image.getPlanes()[0].getBuffer();
                    byte[] bytes = new byte[buf.remaining()];
                    buf.get(bytes);
                    image.close();
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                        fos.write(bytes);
                        sendIntruderNotification(attemptCount, file.getAbsolutePath());
                        Log.d(TAG, "Intruder photo saved: " + file.getAbsolutePath());
                    } catch (IOException e) {
                        Log.e(TAG, "Save error: " + e.getMessage());
                    }
                }
                handlerThread.quitSafely();
                stopSelf();
            }, handler);

            final String finalFrontCamId = frontCamId;
            cameraManager.openCamera(frontCamId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    try {
                        SurfaceTexture st = new SurfaceTexture(1);
                        Surface preview = new Surface(st);
                        Surface capture = reader.getSurface();

                        camera.createCaptureSession(Arrays.asList(preview, capture),
                            new CameraCaptureSession.StateCallback() {
                                @Override
                                public void onConfigured(CameraCaptureSession session) {
                                    try {
                                        CaptureRequest.Builder builder =
                                            camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                        builder.addTarget(capture);
                                        session.capture(builder.build(), null, handler);
                                    } catch (CameraAccessException e) {
                                        Log.e(TAG, "Capture failed: " + e.getMessage());
                                        camera.close();
                                        stopSelf();
                                    }
                                }
                                @Override
                                public void onConfigureFailed(CameraCaptureSession session) {
                                    camera.close();
                                    stopSelf();
                                }
                            }, handler);
                    } catch (CameraAccessException e) {
                        Log.e(TAG, "Session error: " + e.getMessage());
                        camera.close();
                        stopSelf();
                    }
                }
                @Override
                public void onDisconnected(CameraDevice camera) { camera.close(); stopSelf(); }
                @Override
                public void onError(CameraDevice camera, int error) { camera.close(); stopSelf(); }
            }, handler);

        } catch (SecurityException e) {
            Log.e(TAG, "Camera permission missing: " + e.getMessage());
            stopSelf();
        } catch (CameraAccessException e) {
            Log.e(TAG, "Camera access error: " + e.getMessage());
            stopSelf();
        }
    }

    private void sendIntruderNotification(int attempts, String photoPath) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Intruder Alert! (" + attempts + " attempts)")
            .setContentText("Koi aapka phone unlock karne ki koshish kar raha tha! Photo li gayi.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setAutoCancel(true)
            .build();
        nm.notify(1002, n);
    }

    private void createNotificationChannel() {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Intruder Detection",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Background intruder detection service");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
