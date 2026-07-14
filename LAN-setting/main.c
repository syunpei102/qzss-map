/*
 * ESP32-S3 USB→TCP bridge for GNSS receiver
 * USB CDC-ACMデバイスとして接続されたGNSS受信機からデータを読み、
 * Wi-Fi経由でTCPクライアントに垂れ流す。
 *
 * ビルド:ESP-IDF v5.0以降
 * 依存コンポーネント:usb_host_cdc_acm, esp_wifi, lwip
 */
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "nvs_flash.h"
#include "usb/usb_host.h"
#include "usb/cdc_acm_host.h"
#include "lwip/sockets.h"

#define TAG "GNSS_BRIDGE"

// ---- Wi-Fi設定 ----
#define WIFI_SSID     "your-ssid"
#define WIFI_PASS     "your-password"
#define TCP_PORT      5000

// ---- USB設定 ----
// u-blox系はVID=0x1546が多い。実機の`lsusb`で確認して書き換える
#define GNSS_VID      0x1546
#define GNSS_PID      0x01A9

static int client_sock = -1;
static SemaphoreHandle_t client_mutex;

// ============ USB CDC受信コールバック ============
static bool usb_data_cb(const uint8_t *data, size_t data_len, void *arg)
{
    // 接続中のTCPクライアントへそのまま垂れ流す
    xSemaphoreTake(client_mutex, portMAX_DELAY);
    if (client_sock >= 0) {
        int sent = send(client_sock, data, data_len, 0);
        if (sent < 0) {
            ESP_LOGW(TAG, "send failed, closing client");
            close(client_sock);
            client_sock = -1;
        }
    }
    xSemaphoreGive(client_mutex);
    return true;
}

static void usb_event_cb(const cdc_acm_host_dev_event_data_t *event, void *user_ctx)
{
    switch (event->type) {
        case CDC_ACM_HOST_ERROR:
            ESP_LOGE(TAG, "CDC-ACM error: %d", event->data.error);
            break;
        case CDC_ACM_HOST_DEVICE_DISCONNECTED:
            ESP_LOGI(TAG, "GNSS disconnected");
            cdc_acm_host_close(event->data.cdc_hdl);
            break;
        default: break;
    }
}

// ============ USBホストタスク ============
static void usb_host_task(void *arg)
{
    const usb_host_config_t host_config = {
        .intr_flags = ESP_INTR_FLAG_LEVEL1,
    };
    ESP_ERROR_CHECK(usb_host_install(&host_config));
    ESP_ERROR_CHECK(cdc_acm_host_install(NULL));

    while (1) {
        cdc_acm_dev_hdl_t cdc_dev = NULL;
        const cdc_acm_host_device_config_t dev_config = {
            .connection_timeout_ms = 5000,
            .out_buffer_size = 512,
            .in_buffer_size = 512,
            .event_cb = usb_event_cb,
            .data_cb = usb_data_cb,
            .user_arg = NULL,
        };

        ESP_LOGI(TAG, "Waiting for GNSS device (VID=0x%04X PID=0x%04X)...",
                 GNSS_VID, GNSS_PID);
        esp_err_t err = cdc_acm_host_open(GNSS_VID, GNSS_PID, 0,
                                          &dev_config, &cdc_dev);
        if (err != ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        ESP_LOGI(TAG, "GNSS connected");

        // ラインコーディング設定(9600 8N1)
        cdc_acm_line_coding_t line_coding = {
            .dwDTERate = 9600,
            .bCharFormat = 0,
            .bParityType = 0,
            .bDataBits = 8,
        };
        cdc_acm_host_line_coding_set(cdc_dev, &line_coding);

        // データ受信はコールバック経由。ここは接続維持だけ
        while (cdc_dev) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
}

// ============ USBイベントループ ============
static void usb_lib_task(void *arg)
{
    while (1) {
        uint32_t event_flags;
        usb_host_lib_handle_events(portMAX_DELAY, &event_flags);
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            usb_host_device_free_all();
        }
    }
}

// ============ TCPサーバタスク ============
static void tcp_server_task(void *arg)
{
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    int on = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = htonl(INADDR_ANY),
        .sin_port = htons(TCP_PORT),
    };
    bind(srv, (struct sockaddr *)&addr, sizeof(addr));
    listen(srv, 1);
    ESP_LOGI(TAG, "TCP server listening on port %d", TCP_PORT);

    while (1) {
        struct sockaddr_in ca;
        socklen_t cal = sizeof(ca);
        int sock = accept(srv, (struct sockaddr *)&ca, &cal);
        ESP_LOGI(TAG, "Client connected");

        xSemaphoreTake(client_mutex, portMAX_DELAY);
        if (client_sock >= 0) close(client_sock);
        client_sock = sock;
        xSemaphoreGive(client_mutex);
    }
}

// ============ Wi-Fi初期化 ============
static void wifi_init(void)
{
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    wifi_config_t wifi_config = {
        .sta = {
            .ssid = WIFI_SSID,
            .password = WIFI_PASS,
        },
    };
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_connect());
}

// ============ main ============
void app_main(void)
{
    ESP_ERROR_CHECK(nvs_flash_init());
    client_mutex = xSemaphoreCreateMutex();

    wifi_init();
    vTaskDelay(pdMS_TO_TICKS(3000));  // Wi-Fi接続待ち

    xTaskCreatePinnedToCore(usb_lib_task, "usb_lib", 4096, NULL, 10, NULL, 0);
    xTaskCreatePinnedToCore(usb_host_task, "usb_host", 4096, NULL, 5, NULL, 0);
    xTaskCreatePinnedToCore(tcp_server_task, "tcp_srv", 4096, NULL, 5, NULL, 1);
}
