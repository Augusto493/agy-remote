package com.agyremote.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Religa o serviço de notificações quando o celular liga. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) NotifyService.start(ctx);
    }
}
