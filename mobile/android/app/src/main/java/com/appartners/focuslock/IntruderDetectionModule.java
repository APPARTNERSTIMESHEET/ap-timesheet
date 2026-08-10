package com.appartners.focuslock;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.hardware.Camera;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.Surface;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;

/**
 * Native Android module for silent intruder photo capture.
 * Uses Camera2 API to silently capture a front-facing photo.
 */
public class IntruderDetectionModule extends ReactContextBaseJavaModule {

    private static final String TAG = "IntruderDetection";
    private final ReactApplicationContext reactContext;

    public IntruderDetectionModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
    }

    @Override
    public String getName() {
        return "IntruderDetection";
    }

    /**
     * Silently captures a photo using the front camera.
     * Called when wrong unlock attempts exceed the threshold.
     */
    @ReactMethod
    public void captureIntruderPhoto(final Promise promise) {
        CameraManager cameraManager = (CameraManager) reactContext.getSystemService(Context.CAMERA_SERVICE);

        try {
            String frontCameraId = getFrontCameraId(cameraManager);
            if (frontCameraId == null) {
                promise.reject("NO_FRONT_CAMERA", "Front camera nahi mila");
                return;
            }

            HandlerThread handlerThread = new HandlerThread("CameraBackground");
            handlerThread.start();
            Handler backgroundHandler = new Handler(handlerThread.getLooper());

            ImageReader imageReader = ImageReader.newInstance(640, 480, ImageFormat.JPEG, 1);

            String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
            File outputDir = new File(reactContext.getFilesDir(), "intruder_photos");
            if (!outputDir.exists()) outputDir.mkdirs();
            File outputFile = new File(outputDir, "intruder_" + timestamp + ".jpg");

            imageReader.setOnImageAvailableListener(reader -> {
                android.media.Image image = reader.acquireLatestImage();
                if (image != null) {
                    ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                    byte[] bytes = new byte[buffer.remaining()];
                    buffer.get(bytes);
                    image.close();

                    try (FileOutputStream fos = new FileOutputStream(outputFile)) {
                        fos.write(bytes);
                        promise.resolve(outputFile.getAbsolutePath());
                    } catch (IOException e) {
                        promise.reject("SAVE_ERROR", "Photo save nahi hui: " + e.getMessage());
                    }
                }
                handlerThread.quitSafely();
            }, backgroundHandler);

            cameraManager.openCamera(frontCameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice camera) {
                    try {
                        SurfaceTexture surfaceTexture = new SurfaceTexture(1);
                        Surface previewSurface = new Surface(surfaceTexture);
                        Surface captureSurface = imageReader.getSurface();

                        camera.createCaptureSession(
                            Arrays.asList(previewSurface, captureSurface),
                            new CameraCaptureSession.StateCallback() {
                                @Override
                                public void onConfigured(CameraCaptureSession session) {
                                    try {
                                        CaptureRequest.Builder builder = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                                        builder.addTarget(captureSurface);
                                        builder.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_AUTO);
                                        session.capture(builder.build(), null, backgroundHandler);
                                    } catch (CameraAccessException e) {
                                        promise.reject("CAPTURE_ERROR", e.getMessage());
                                        camera.close();
                                    }
                                }
                                @Override
                                public void onConfigureFailed(CameraCaptureSession session) {
                                    promise.reject("CONFIG_ERROR", "Camera configure nahi hua");
                                    camera.close();
                                }
                            },
                            backgroundHandler
                        );
                    } catch (CameraAccessException e) {
                        promise.reject("SESSION_ERROR", e.getMessage());
                        camera.close();
                    }
                }
                @Override
                public void onDisconnected(CameraDevice camera) { camera.close(); }
                @Override
                public void onError(CameraDevice camera, int error) {
                    camera.close();
                    promise.reject("CAMERA_ERROR", "Camera error: " + error);
                }
            }, backgroundHandler);

        } catch (SecurityException e) {
            promise.reject("PERMISSION_ERROR", "Camera permission nahi hai");
        } catch (CameraAccessException e) {
            promise.reject("CAMERA_ACCESS_ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void lockScreen(final Promise promise) {
        try {
            DevicePolicyManager dpm = (DevicePolicyManager)
                reactContext.getSystemService(Context.DEVICE_POLICY_SERVICE);
            ComponentName adminComponent = new ComponentName(reactContext, DeviceAdminReceiver.class);

            if (dpm.isAdminActive(adminComponent)) {
                dpm.lockNow();
                promise.resolve(true);
            } else {
                // Request device admin
                Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
                intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent);
                intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                    "Focus Lock mode ke liye Device Admin permission chahiye");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                reactContext.startActivity(intent);
                promise.resolve(false);
            }
        } catch (Exception e) {
            promise.reject("LOCK_ERROR", e.getMessage());
        }
    }

    private String getFrontCameraId(CameraManager manager) throws CameraAccessException {
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics chars = manager.getCameraCharacteristics(id);
            Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT) {
                return id;
            }
        }
        return null;
    }
}
